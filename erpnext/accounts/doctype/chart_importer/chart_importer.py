# -*- coding: utf-8 -*-
# Copyright (c) 2019, Frappe Technologies Pvt. Ltd. and contributors
# For license information, please see license.txt

from __future__ import unicode_literals
from functools import reduce
import frappe, csv, os
from frappe import _
from frappe.utils import cstr, cint
from frappe.model.document import Document
from frappe.utils.csvutils import UnicodeWriter
from erpnext.accounts.doctype.account.chart_of_accounts.chart_of_accounts import create_charts, build_tree_from_json, identify_is_group
from frappe.utils.xlsxutils import read_xlsx_file_from_attached_file, read_xls_file_from_attached_file, make_xlsx
from frappe.utils.nestedset import rebuild_tree
from six import iteritems

class ChartImporter(Document):
	pass

@frappe.whitelist()
def validate_company(company):
	parent_company, allow_account_creation_against_child_company = frappe.db.get_value('Company',
		{'name': company}, ['parent_company',
		'allow_account_creation_against_child_company'])

	if parent_company and (not allow_account_creation_against_child_company):
		frappe.throw(_("""{0} is a child company. Please import chart against parent company
			or enable {1} in company master""").format(frappe.bold(company),
			frappe.bold('Allow Account Creation Against Child Company')), title='Wrong Company')

	if frappe.db.get_all('GL Entry', {"company": company}, "name", limit=1):
		return False

@frappe.whitelist()
def import_chart(file_name, chart_type, company):
	# delete existing data for chart
	unset_existing_data(chart_type, company)

	# create accounts
	data = generate_data(file_name)

	forest = build_forest(data)
	if (chart_type == 'Account'):
		create_charts(company, custom_chart=forest)

		# trigger on_update for company to reset default accounts
		set_default_accounts(company)
	else: # Cost Centers
		frappe.local.flags.ignore_validate = True
		cc_dir = {}
		import_cost_centers(company, forest, None, cc_dir)
		resolve_distributions(cc_dir)
		rebuild_tree("Cost Center", "parent_cost_center")
		frappe.local.flags.ignore_validate = False

def import_cost_centers(company, kids, parent, cdir):
	for name, data in iteritems(kids):
		try: num = data.get('cost_center_number','').strip()
		except: continue

		is_group = 0
		if identify_is_group(data): is_group = 1

		enable_dist = int(data.get('enable_distributed_cost_center', 0))
		dcc_field = 'cost_center_(distributed_cost_center)'
		dcpa_field = 'percentage_allocation_(distributed_cost_center)'
		dists = data.pop('continuations', [])
		dists.insert(0, {dcc_field: data.pop(dcc_field, None),
				 dcpa_field: data.pop(dcpa_field, None)})
		if not enable_dist: dists = []

		cc_dict = { 'doctype': 'Cost Center',
			    'cost_center_name': name,
			    'company': company,
			    'parent_cost_center': parent,
			    'is_group': is_group,
			    'cost_center_number': num,
			    'enable_distributed_cost_center': enable_dist
		}

		# Copy any remaining data fields into the new record
		for field, val in iteritems(data):
			# Skip the dicts, those are children
			try:
				if val.get('dummy_field', True): continue
			except: pass
			if field not in cc_dict:
				cc_dict[field] = val

		cost_ctr = frappe.get_doc(cc_dict)
		cost_ctr.flags.ignore_permissions = True
		cost_ctr.flags.ignore_mandatory = True
		cost_ctr.insert()
		assigned_name = cost_ctr.as_dict()['name']
		cdir[name] = (assigned_name, dists)

		import_cost_centers(company, data, assigned_name, cdir)

def resolve_distributions(cdir):
	dcc_field = 'cost_center_(distributed_cost_center)'
	dcpa_field = 'percentage_allocation_(distributed_cost_center)'
	for name, val in iteritems(cdir):
		id, dists = val
		if len(dists) == 0: continue
		cc = frappe.get_doc('Cost Center', id)
		for d in dists:
			cc.append('distributed_cost_center',
				  {'cost_center': cdir[d[dcc_field]][0],
				   'percentage_allocation': d[dcpa_field]})
		cc.save()

def get_file(file_name):
	file_doc = frappe.get_doc("File", {"file_url": file_name})
	parts = file_doc.get_extension()
	extension = parts[1]
	extension = extension.lstrip(".")

	if extension not in ('csv', 'xlsx', 'xls'):
		frappe.throw(_("Only CSV and Excel files can be used to for importing data. Please check the file format you are trying to upload"))

	return file_doc, extension

def rows_of_csv(filedoc):
	with open(filedoc.get_full_path(), 'r') as f:
		return list(csv.reader(f))

def generate_data(file_name):
	''' read spreadsheet file and return a dict of record names associated with record dicts '''

	row_xtract = {
		'xls': lambda fd: read_xls_file_from_attached_file(content=fd.get_content()),
		'xlsx': lambda fd: read_xlsx_file_from_attached_file(fcontent=fd.get_content()),
		'csv': rows_of_csv
	}
	file_doc, extension = get_file(file_name)
	rows = row_xtract[extension](file_doc)

	data = {}
	prev_name = False
	header = [frappe.scrub(h) for h in rows.pop(0)[1:]]
	for row in rows:
		rdict = dict(zip(header, row[1:]))
		# Make sure is_group is a numerical field if present, since '0' is
		# interpreted as true in Python
		if rdict.get('is_group', False):
			try:
				numerical = int(rdict['is_group'])
				rdict['is_group'] = numerical
			except: pass
		if not row[0]:
			# Continuation line (for Cost Center import)
			if not prev_name:
				frappe.throw(_("Initial row cannot be a continuation"))
			data[prev_name].setdefault('continuations', []).append(rdict)
			continue
		prev_name = row[0]
		if prev_name in data:
			frappe.throw(_("Multiple records with name {0}").format(prev_name))
		data[prev_name] = rdict
	return data

@frappe.whitelist()
def get_chart(doctype, chart_type, parent, is_root=False, file_name=None):
	''' called by tree view (to fetch node's children) '''

	if parent == _('All Accounts') or parent == _('All Cost Centers'):
		parent = None
	data = generate_data(file_name)

	chart_type = frappe.scrub(chart_type)
	forest = build_forest(data)
	# get alist of dict in a tree render-able form:
	accounts = build_tree_from_json("", chart_data=forest, val_field=f"{chart_type}_number")

	# filter out to show data for the selected node only
	return list(filter(lambda a: a['parent_name'] == parent, accounts))

def build_forest(data):
	'''
		converts dict of records into a nested tree
		if a = {1: {parent_name:'', anykey:'a'},
			2: {parent_name:1, otherkey:2},
			3: {parent_name:2, akey:'mi'},
			4: {parent_name:'', somekey:'Apr'},
			5: {parent_name:4, hokey:'blue'}}
		tree = {
			1: {    anykey: 'a',
				2: {    otherkey: 2,
					3: { akey: 'mi' }
				}
			},
			4: {    somekey: 'Apr',
				5: { hokey: 'blue' }
			}
		}
	'''

	no_parent = False
	data[no_parent] = {}
	missing = {}
	for name in data:
		if name is no_parent: continue
		parent = data[name].pop('parent_name') or no_parent
		if parent not in data:
			missing[parent] = True
			continue
		data[parent][name] = data[name]

	missing = missing.keys()
	if len(missing) == 1:
		frappe.throw(_("Record for parent named {0} does not exist in the uploaded template").format(frappe.bold(missing[0])))
	if len(missing) > 0:
		frappe.throw(_("Records for parents named {0} do not exist in the uploaded template").format(frappe.bold(",".join(missing))))

	return data[no_parent]

@frappe.whitelist()
def download_template(file_type, template_type, chart_type):
	data = frappe._dict(frappe.local.form_dict)

	if chart_type == 'Account':
		rows = get_account_template(template_type)
	else:
		rows = get_cost_template(template_type)

	if file_type == 'CSV':
		writer = UnicodeWriter()
		for row in rows: writer.writerow(row)

		# download csv file
		frappe.response['result'] = cstr(writer.getvalue())
		frappe.response['type'] = 'csv'
		frappe.response['doctype'] = 'Chart Importer'
	else:
		xlsx_file = make_xlsx(rows, "Chart Importer Template")

		# write out response as a xlsx type
		frappe.response['filename'] = f"{frappe.scrub(chart_type)}_{frappe.scrub(template_type)}.xlsx"
		frappe.response['filecontent'] = xlsx_file.getvalue()
		frappe.response['type'] = 'binary'

def get_account_template(template_type):
	rows = [["Name", "Parent Name", "Account Number", "Is Group", "Account Type", "Root Type", "Description"]]

	if template_type == 'Blank Template':
		for root_type in get_root_types():
			rows.append(['', '', '', 1, '', root_type, ''])

		for account in get_mandatory_group_accounts():
			rows.append(['', '', '', 1, account, "Asset", ''])

		for account_type in get_mandatory_account_types():
			rows.append(['', '', '', 0, account_type.get('account_type'), account_type.get('root_type'), ''])

		return rows

	rows.extend([
		["Application of Funds(Assets)", "", "", 1, "", "Asset", ""],
		["Sources of Funds(Liabilities)", "", "", 1, "", "Liability", ""],
		["Equity", "", "", 1, "", "Equity", "Accounts that represent owner's value or opening balances"],
		["Expenses", "", "", 1, "", "Expense", ""],
		["Income", "", "", 1, "", "Income", ""],
		["Bank Accounts", "Application of Funds(Assets)", "", 1, "Bank", "Asset", "Accounts that represent value held at financial institutions"],
		["Cash In Hand", "Application of Funds(Assets)", "", 1, "Cash", "Asset",""],
		["Stock Assets", "Application of Funds(Assets)", "", 1, "Stock", "Asset", "Accounts that represent goods in inventory"],
		["Cost of Goods Sold", "Expenses", "", 0, "Cost of Goods Sold", "Expense", ""],
		["Asset Depreciation", "Expenses", "", 0, "Depreciation", "Expense", ""],
		["Fixed Assets", "Application of Funds(Assets)", "", 0, "Fixed Asset", "Asset", ""],
		["Accounts Payable", "Sources of Funds(Liabilities)", "", 0, "Payable", "Liability", ""],
		["Accounts Receivable", "Application of Funds(Assets)", "", 0, "Receivable", "Asset", ""],
		["Stock Expenses", "Expenses", "", 0, "Stock Adjustment", "Expense", "Value of lost or spoiled inventory"],
		["Sample Bank", "Bank Accounts", "", 0, "Bank", "Asset", "Rename to reflect your actual bank"],
		["Cash", "Cash In Hand", "", 0, "Cash", "Asset", ""],
		["Stores", "Stock Assets", "", 0, "Stock", "Asset", "Alternately named 'Inventory'"],
	])

	return rows

def get_cost_template(template_type):
	rows = [['Name', 'Parent Name', 'Cost Center Number', 'Is Group', 'Enable Distributed Cost Center', 'Cost Center (Distributed Cost Center)', 'Percentage Allocation (Distributed Cost Center)']]

	if template_type == 'Blank Template':
		rows.extend([
			['At Least One Top Level Group', '', '', 1, 0, '', ''],
			['A Cost Center', 'At Least One Top Level Group', '', 0, 0, '', '']
		])
	else:
		rows.extend([
			['Sales', '', '', 1, 0, '', ''],
			['In-store', 'Sales', '', 0, 0, '', ''],
			['On-line', 'Sales', '', 0, 0, '', ''],
			['Service', '', '', 1, 0, '', ''],
			['Repairs', 'Service', '', 0, 0, '', ''],
			['Installations', 'Service', '', 0, 0, '', ''],
			['Allocations', '', '', 1, 0, '', ''],
			['Rent', 'Allocations', '', 0, 1, 'In-store', 70],
			['', '', '', '', '', 'Repairs', 30],
			['Overhead', 'Allocations', '', 0, 1, 'In-store', 40],
			['', '', '', '', '', 'On-line', 30],
			['', '', '', '', '', 'Repairs', 20],
			['', '', '', '', '', 'Installations', 10],
		])
	return rows

@frappe.whitelist()
def validate_accounts(file_name, chart_type):
	data = generate_data(file_name)
	for account in data:
		parent = data[account]['parent_name']
		if parent: data[parent]['is_group'] = 1

	message = validate_root(data, chart_type)
	if message: return message
	if chart_type == 'Account':
		message = validate_account_types(data)
	else: # Cost centers
		message = validate_distributions(data)
	if message: return message

	return [True, len(data)]

def validate_root(accounts, chart_type):
	min_roots = 1
	if chart_type == 'Account': min_roots = 4

	roots = [accounts[d] for d in accounts if not accounts[d].get('parent_account')]
	if len(roots) < min_roots:
		return _("Number of root accounts cannot be less than {0}").format(min_roots)

	if chart_type != 'Account': return

	error_messages = []

	for account in roots:
		if not account.get("root_type") and account.get("account_name"):
			error_messages.append("Please enter Root Type for account- {0}".format(account.get("account_name")))
		elif account.get("root_type") not in get_root_types() and account.get("account_name"):
			error_messages.append("Root Type for {0} must be one of the Asset, Liability, Income, Expense and Equity".format(account.get("account_name")))

	if error_messages:
		return "<br>".join(error_messages)

def get_root_types():
	return ('Asset', 'Liability', 'Expense', 'Income', 'Equity')

def get_report_type(root_type):
	if root_type in ('Asset', 'Liability', 'Equity'):
		return 'Balance Sheet'
	else:
		return 'Profit and Loss'

def get_mandatory_group_accounts():
	return ('Bank', 'Cash', 'Stock')

def get_mandatory_account_types():
	return [
		{'account_type': 'Cost of Goods Sold', 'root_type': 'Expense'},
		{'account_type': 'Depreciation', 'root_type': 'Expense'},
		{'account_type': 'Fixed Asset', 'root_type': 'Asset'},
		{'account_type': 'Payable', 'root_type': 'Liability'},
		{'account_type': 'Receivable', 'root_type': 'Asset'},
		{'account_type': 'Stock Adjustment', 'root_type': 'Expense'},
		{'account_type': 'Bank', 'root_type': 'Asset'},
		{'account_type': 'Cash', 'root_type': 'Asset'},
		{'account_type': 'Stock', 'root_type': 'Asset'}
	]


def validate_account_types(accounts):
	account_types_for_ledger = ["Cost of Goods Sold", "Depreciation", "Fixed Asset", "Payable", "Receivable", "Stock Adjustment"]
	account_types = [accounts[d]["account_type"] for d in accounts if not accounts[d]['is_group'] == 1]

	missing = list(set(account_types_for_ledger) - set(account_types))
	if missing:
		return _("Please identify/create Account (Ledger) for type - {0}").format(' , '.join(missing))

	account_types_for_group = ["Bank", "Cash", "Stock"]
	# fix logic bug
	account_groups = [accounts[d]["account_type"] for d in accounts if accounts[d]['is_group'] == 1]

	missing = list(set(account_types_for_group) - set(account_groups))
	if missing:
		return _("Please identify/create Account (Group) for type - {0}").format(' , '.join(missing))

def validate_distributions(ccs):
	dcpa_field = 'percentage_allocation_(distributed_cost_center)'
	messages = []
	for cc,data in iteritems(ccs):
		if int(data.get('enable_distributed_cost_center', 0)) == 0:
			continue
		total = float(data.get(dcpa_field, 0.0))
		for line in data.get('continuations',[]):
			total += float(line.get(dcpa_field, 0.0))
		if abs(total - 100.0) > 0.1:
			messages.append(_("Sum of percent allocations for {0} is {1}, not 100").format(cc, total))
	if len(messages):
		return "<br>".join(messages)

def unset_existing_data(chart_type, company):
	linked = frappe.db.sql('''select fieldname from tabDocField
		where fieldtype="Link" and options="{0}" and parent="Company"'''.format(chart_type), as_dict=True)

	# remove chart data from company
	update_values = {d.fieldname: '' for d in linked}
	frappe.db.set_value('Company', company, update_values, update_values)

	# remove chart data from various doctypes
	affected_doctypes = [chart_type]
	if chart_type == 'Account':
		affected_doctypes.extend(["Party Account", "Mode of Payment Account", "Tax Withholding Account",
			"Sales Taxes and Charges Template", "Purchase Taxes and Charges Template"])
	for doctype in affected_doctypes:
		frappe.db.sql('''delete from `tab{0}` where `company`="%s"''' # nosec
			.format(doctype) % (company))

def set_default_accounts(company):
	from erpnext.setup.doctype.company.company import install_country_fixtures
	company = frappe.get_doc('Company', company)
	company.update({
		"default_receivable_account": frappe.db.get_value("Account",
			{"company": company.name, "account_type": "Receivable", "is_group": 0}),
		"default_payable_account": frappe.db.get_value("Account",
			{"company": company.name, "account_type": "Payable", "is_group": 0})
	})

	company.save()
	install_country_fixtures(company.name)
	company.create_default_tax_template()
