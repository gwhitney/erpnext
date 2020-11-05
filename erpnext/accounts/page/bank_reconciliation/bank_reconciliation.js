frappe.provide("erpnext.accounts");

frappe.pages['bank-reconciliation'].on_page_load = function(wrapper) {
	// Assign to a global variable for ease of access in web console
	erpnext.accounts.bankRecTopLevel = new erpnext.accounts.bankReconciliation(wrapper);
}

erpnext.accounts.bankReconciliation = class BankReconciliation {
	constructor(wrapper) {
		this.page = frappe.ui.make_app_page({
			parent: wrapper,
			title: __("Bank Reconciliation"),
			single_column: true
		});
		this.parent = wrapper;
		this.page = this.parent.page;

		this.check_plaid_status();
		this.make();
	}

	display_empty_state() {
		const empty_state = __("Upload a bank statement, link or reconcile a bank account");
		this.$main_section.append(`<div class="flex justify-center align-center text-muted"
			style="height: 50vh; display: flex;"><h5 class="text-muted">${empty_state}</h5></div>`);
	}

	make() {
		const me = this;

		me.$main_section = $(`<div class="reconciliation page-main-content"></div>`).appendTo(me.page.main);
		me.display_empty_state();
		me.company = frappe.defaults.get_user_default("Company");

		me.page.add_field({
			fieldtype: 'Link',
			label: __('Company'),
			fieldname: 'company',
			options: "Company",
			default: me.company,
			onchange: function() {
				if (this.value != me.company) {
					me.company = this.value || null;
					me.page.fields_dict.bank_account.set_input(null);
					me.bank_account = null;
					me.page.hide_menu();
					me.clear_page_content();
					me.page.clear_secondary_action();
					me.display_empty_state();
				}
			}
		})
		me.page.add_field({
			fieldtype: 'Link',
			label: __('Bank Account'),
			fieldname: 'bank_account',
			options: "Bank Account",
			get_query: function() {
				if(!me.company) {
					frappe.throw(__("Please select company first"));
					return
				}

				return {
					filters: {
						"company": me.company
					}
				}
			},
			onchange: function() {
				if (this.value != me.bank_account) {
					if (this.value) {
						me.bank_account = this.value;
						me.add_actions();
					} else {
						me.bank_account = null;
						me.page.hide_menu();
					}
					if (erpnext.accounts.ReconciliationList) {
						erpnext.accounts.ReconciliationList.filter_area.refresh_list_view();
					}
				}
			}
		})
	}

	check_plaid_status() {
		const me = this;
		frappe.db.get_value("Plaid Settings", "Plaid Settings", "enabled", (r) => {
			if (r && r.enabled === "1") {
				me.plaid_status = "active"
			} else {
				me.plaid_status = "inactive"
			}
		})
	}

	add_actions() {
		const me = this;

		me.page.show_menu()

		me.page.add_menu_item(__("Upload a statement"), function() {
			me.clear_page_content();
			new erpnext.accounts.bankTransactionUpload(me);
		}, true)

		if (me.plaid_status==="active") {
			me.page.add_menu_item(__("Synchronize this account"), function() {
				me.clear_page_content();
				new erpnext.accounts.bankTransactionSync(me);
			}, true)
		}

		me.page.add_menu_item(__("Reconcile this account"), function() {
			me.clear_page_content();
			me.make_reconciliation_tool();
		}, true)
	}

	clear_page_content() {
		const me = this;
		$(me.page.body).find('.frappe-list').remove();
		me.$main_section.empty();
		const fd = me.page.fields_dict;
		for (let key in fd) {
			if (key != "bank_account" && key != "company" && fd[key]) {
				fd[key].wrapper.remove();
				delete fd[key];
			}
		}
	}

	make_reconciliation_tool() {
		const me = this;
		me.page.add_field({
			fieldtype: "Check",
			fieldname: "reverse_proposals",
			label: __("Sort older matches last"),
			report_hide: 1,
			default: 1
		})
		frappe.model.with_doctype("Bank Transaction", () => {
			erpnext.accounts.ReconciliationList = new erpnext.accounts.ReconciliationTool({
				parent: me.parent,
				doctype: "Bank Transaction",
				custom_filter_configs: [{
					fieldname: "_ignore_all",
					fieldtype: "Check",
					hidden: 1
				}]
			});
		})
	}
}


erpnext.accounts.bankTransactionUpload = class bankTransactionUpload {
	constructor(parent) {
		this.parent = parent;
		this.data = [];

		const assets = [
			"/assets/frappe/css/frappe-datatable.css",
			"/assets/frappe/js/lib/clusterize.min.js",
			"/assets/frappe/js/lib/Sortable.min.js",
			"/assets/frappe/js/lib/frappe-datatable.js"
		];

		frappe.require(assets, () => {
			this.make();
		});
	}

	make() {
		const me = this;
		new frappe.ui.FileUploader({
			method: 'erpnext.accounts.doctype.bank_transaction.bank_transaction_upload.upload_bank_statement',
			allow_multiple: 0,
			on_success: function(attachment, r) {
				if (!r.exc && r.message) {
					me.data = r.message;
					me.setup_transactions_dom();
					me.create_datatable();
					me.add_primary_action();
				}
			}
		})
	}

	setup_transactions_dom() {
		const me = this;
		me.parent.$main_section.append(`<div class="transactions-table"></div>`)
	}

	create_datatable() {
		try {
			this.datatable = new DataTable('.transactions-table', {
				columns: this.data.columns,
				data: this.data.data
			})
		}
		catch(err) {
			let msg = __("Your file could not be processed by ERPNext.")
				+ __("<br>It should be a standard CSV or XLSX file.")
				+ __("<br>The headers should be in the first row.");
			frappe.throw(msg);
		}

	}

	add_primary_action() {
		const me = this;
		me.parent.page.set_primary_action(__("Submit"), function() {
			me.add_bank_entries()
		}, null, __("Creating bank entries..."))
	}

	add_bank_entries() {
		const me = this;
		frappe.xcall('erpnext.accounts.doctype.bank_transaction.bank_transaction_upload.create_bank_entries',
			{columns: this.datatable.datamanager.columns, data: this.datatable.datamanager.data, bank_account: me.parent.bank_account}
		).then((result) => {
			let result_title = result.errors == 0 ? __("{0} bank transaction(s) created", [result.success]) : __("{0} bank transaction(s) created and {1} errors", [result.success, result.errors])
			let result_msg = `
				<div class="flex justify-center align-center text-muted" style="height: 50vh; display: flex;">
					<h5 class="text-muted">${result_title}</h5>
				</div>`
			me.parent.page.clear_primary_action();
			me.parent.$main_section.empty();
			me.parent.$main_section.append(result_msg);
			if (result.errors == 0) {
				frappe.show_alert({message:__("All bank transactions have been created"), indicator:'green'});
			} else {
				frappe.show_alert({message:__("Please check the error log for details about the import errors"), indicator:'red'});
			}
		})
	}
}

erpnext.accounts.bankTransactionSync = class bankTransactionSync {
	constructor(parent) {
		this.parent = parent;
		this.data = [];

		this.init_config()
	}

	init_config() {
		const me = this;
		frappe.xcall('erpnext.erpnext_integrations.doctype.plaid_settings.plaid_settings.get_plaid_configuration')
			.then(result => {
				me.plaid_env = result.plaid_env;
				me.client_name = result.client_name;
				me.link_token = result.link_token;
				me.sync_transactions();
			})
	}

	sync_transactions() {
		const me = this;
		frappe.db.get_value("Bank Account", me.parent.bank_account, "bank", (r) => {
			frappe.xcall('erpnext.erpnext_integrations.doctype.plaid_settings.plaid_settings.sync_transactions', {
				bank: r.bank,
				bank_account: me.parent.bank_account,
				freeze: true
			})
			.then((result) => {
				let result_title = (result && result.length > 0)
					? __("{0} bank transaction(s) created", [result.length])
					: __("This bank account is already synchronized");

				let result_msg = `
				<div class="flex justify-center align-center text-muted" style="height: 50vh; display: flex;">
					<h5 class="text-muted">${result_title}</h5>
				</div>`

				this.parent.$main_section.append(result_msg)
				frappe.show_alert({ message: __("Bank account '{0}' has been synchronized", [me.parent.bank_account]), indicator: 'green' });
			})
		})
	}
}


erpnext.accounts.ReconciliationTool = class ReconciliationTool extends frappe.views.BaseList {
	constructor(opts) {
		super(opts);
		this.show();
	}

	setup_defaults() {
		super.setup_defaults();

		this.page_title = __("Bank Reconciliation");
		this.doctype = 'Bank Transaction';
		this.fields = ['date', 'description', 'debit', 'credit', 'currency', 'unallocated_amount'];
	}

	setup_view() {
		this.render_header();
	}

	setup_side_bar() {
		//
	}

	freeze() {
		this.$result.find('.list-count').html(`<span>${__('Refreshing')}...</span>`);
	}

	get_args() {
		const args = super.get_args();

		let filt = args.filters.filter(f => (f[1] !== "reverse_proposals"));
		filt.push(["Bank Transaction", "docstatus", "=", 1],
			["Bank Transaction", "unallocated_amount", ">", 0]);

		return Object.assign({}, args, {filters: filt});
	}

	update_data(r) {
		let data = r.message || [];

		if (this.start === 0) {
			this.data = data;
		} else {
			this.data = this.data.concat(data);
		}
	}

	render() {
		const me = this;
		this.$result.find('.list-row-container').remove();
		$('[data-fieldname="name"]').remove();
		me.data.forEach((value) => {
			const row = $('<div class="list-row-container">').data("data", value).appendTo(me.$result).get(0);
			value.company = me.page.fields_dict.company.value;
			value.reverse_field = me.page.fields_dict.reverse_proposals;
			const tot = value.credit + value.debit;
			value.amount_described = (value.credit > 0 ? "Cr " : "Dr ") + format_currency(tot, value.currency);
			if (tot != value.unallocated_amount) {
				value.amount_described += " (" + value.unallocated_amount + ")";
			}
			new erpnext.accounts.ReconciliationRow(row, value);
		})
	}

	render_header() {
		const me = this;
		if ($(this.wrapper).find('.transaction-header').length === 0) {
			me.$result.append(frappe.render_template("bank_transaction_header"));
		}
	}
}

erpnext.accounts.ReconciliationRow = class ReconciliationRow {
	constructor(row, data) {
		this.data = data;
		this.row = row;
		this.make();
		this.bind_events();
	}

	make() {
		$(this.row).append(frappe.render_template("bank_transaction_row", this.data))
	}

	bind_events() {
		const me = this;

		frappe.db.get_value("Bank Account", me.data.bank_account, "account", (r) => {
			me.gl_account = r.account;
		});

		$(me.row).on('click', '.clickable-section', function() {
			me.bank_entry = $(this).attr("data-name");
			me.show_dialog($(this).attr("data-name"));
		})

		$(me.row).on('click', '.new-reconciliation', function() {
			me.bank_entry = $(this).attr("data-name");
			me.show_dialog($(this).attr("data-name"));
		})

		$(me.row).on('click', '.new-payment', function() {
			me.bank_entry = $(this).attr("data-name");
			me.new_payment();
		})

		$(me.row).on('click', '.new-bankentry', function() {
			me.new_bank_entry();
		})

		$(me.row).on('click', '.new-invoice', function() {
			me.bank_entry = $(this).attr("data-name");
			me.new_invoice();
		})

		$(me.row).on('click', '.new-expense', function() {
			me.bank_entry = $(this).attr("data-name");
			me.new_expense();
		})
	}

	new_payment() {
		const me = this;
		const paid_amount = me.data.credit > 0 ? me.data.credit : me.data.debit;
		const payment_type = me.data.credit > 0 ? "Receive": "Pay";
		const party_type = me.data.credit > 0 ? "Customer": "Supplier";
		const account_field = me.data.credit > 0 ? "paid_to" : "paid_from";
		let payment_template = {payment_type: payment_type, party_type: party_type};
		payment_template[account_field] = me.gl_account;
		frappe.new_doc("Payment Entry", payment_template, doc => {
			doc.paid_amount = paid_amount;
		});
	}

	async new_bank_entry() {
		const me = this;
		const ba_doc = await frappe.db.get_doc("Bank Account",
			me.data.bank_account);
		const je_type = ba_doc.account_type === "Credit Card" ? "Credit Card Entry" : "Bank Entry";
		frappe.new_doc("Journal Entry",
			{
				"company": me.data.company,
				"voucher_type": je_type
//				"accounts": [{
//					"doctype": "Journal Entry Account",
//					"account": ba_doc.account,
//					"debit": me.data.credit, "credit": me.data.debit,
//					"account_currency": me.data.currency,
//				}],
			}, doc => {
				doc.posting_date = me.data.date;
				doc.user_remark = me.data.description || "";
				if (me.data.transaction_id) {
					doc.user_remark += "Transaction ID: " + me.data.transaction_id;
				}
				doc.cheque_no = me.data.reference_number;
				doc.cheque_date = me.data.date;
				let newacc = frappe.model.add_child(doc, "accounts");
				newacc.account = ba_doc.account;
				newacc.account_currency = me.data.currency;
				newacc.debit_in_account_currency = me.data.credit;
				newacc.credit_in_account_currency = me.data.debit;
			}
		);
	}

	new_invoice() {
		const me = this;
		const invoice_type = me.data.credit > 0 ? "Sales Invoice" : "Purchase Invoice";

		frappe.new_doc(invoice_type)
	}

	new_expense() {
		frappe.new_doc("Expense Claim")
	}


	show_dialog(data) {
		const me = this;

		frappe.xcall('erpnext.accounts.page.bank_reconciliation.bank_reconciliation.get_linked_payments', {
			bank_transaction: data,
			reverse_proposals: me.data.reverse_field.last_value,
			freeze: true, freeze_message: __("Finding linked payments")
		}).then((result) => {
			me.make_dialog(result)
		})
	}

	make_dialog(data) {
		const me = this;
		me.selected_payment = null;
		let summary = me.data.date + '&nbsp;&nbsp;&nbsp;';
		summary += me.data.debit > 0 ? 'Dr ' : 'Cr ';
		const tot = me.data.debit+me.data.credit;
		summary += format_currency(tot, me.data.currency);
		if (me.data.unallocated_amount != tot) {
			summary += ' (Unallocated: ' + format_currency(me.data.unallocated_amount, me.data.currency) + ')';
		}
		const fields = [
			{
				fieldtype: 'Section Break',
				fieldname: 'section_break_0',
				label: __('Currently Reconciling:'),
				description: summary
			},
			{
				fieldtype: 'Text',
				fieldname: 'transaction_description',
				label: __('Description'),
				default: me.data.description,
				read_only: 1
			},
			{
				fieldtype: 'Section Break',
				fieldname: 'section_break_1',
				label: __('Automatic Reconciliation')
			},
			{
				fieldtype: 'HTML',
				fieldname: 'payment_proposals'
			},
			{
				fieldtype: 'Section Break',
				fieldname: 'section_break_2',
				label: __('Search for a payment')
			},
			{
				fieldtype: 'Link',
				fieldname: 'payment_doctype',
				options: 'DocType',
				label: 'Payment DocType',
				get_query: () => {
					return {
						filters : {
							"name": ["in", ["Payment Entry", "Journal Entry", "Sales Invoice", "Purchase Invoice", "Expense Claim"]]
						}
					}
				},
			},
			{
				fieldtype: 'Column Break',
				fieldname: 'column_break_1',
			},
			{
				fieldtype: 'Dynamic Link',
				fieldname: 'payment_entry',
				options: 'payment_doctype',
				label: 'Payment Document',
				get_query: () => {
					let dt = this.dialog.fields_dict.payment_doctype.value;
					if (dt === "Payment Entry") {
						return {
							query: "erpnext.accounts.page.bank_reconciliation.bank_reconciliation.payment_entry_query",
							filters : {
								"bank_account": this.data.bank_account,
								"company": this.data.company
							}
						}
					} else if (dt === "Journal Entry") {
						return {
							query: "erpnext.accounts.page.bank_reconciliation.bank_reconciliation.journal_entry_query",
							filters : {
								"bank_account": this.data.bank_account,
								"company": this.data.company
							}
						}
					} else if (dt === "Sales Invoice") {
						return {
							query: "erpnext.accounts.page.bank_reconciliation.bank_reconciliation.sales_invoices_query",
							filters: { "bank_account": this.data.bank_account }
						}
					} else if (dt === "Purchase Invoice") {
						return {
							filters : [
								["Purchase Invoice", "ifnull(clearance_date, '')", "=", ""],
								["Purchase Invoice", "docstatus", "=", 1],
								["Purchase Invoice", "company", "=", this.data.company]
							]
						}
					} else if (dt === "Expense Claim") {
						return {
							filters : [
								["Expense Claim", "ifnull(clearance_date, '')", "=", ""],
								["Expense Claim", "docstatus", "=", 1],
								["Expense Claim", "company", "=", this.data.company]
							]
						}
					}
				},
				onchange: function() {
					if (me.selected_payment !== this.value) {
						me.selected_payment = this.value;
						me.display_payment_details(this);
					}
				}
			},
			{
				fieldtype: 'Section Break',
				fieldname: 'section_break_3'
			},
			{
				fieldtype: 'HTML',
				fieldname: 'payment_details'
			},
		];

		me.dialog = new frappe.ui.Dialog({
			title: __("Choose a corresponding payment"),
			fields: fields,
			size: "large"
		});

		me.display_entries(me.dialog.fields_dict.payment_proposals.$wrapper, data,
			__("ERPNext could not find any matching payment entry")
		);
		$(me.dialog.body).on('click', '.reconciliation-btn', (e) => {
			const payment_entry = $(e.target).attr('data-name');
			const payment_doctype = $(e.target).attr('data-doctype');
			frappe.xcall('erpnext.accounts.page.bank_reconciliation.bank_reconciliation.reconcile',
				{bank_transaction: me.bank_entry, payment_doctype: payment_doctype, payment_name: payment_entry})
			.then((result) => {
				setTimeout(function(){
					erpnext.accounts.ReconciliationList.refresh();
				}, 2000);
				me.dialog.hide();
			})
		})

		me.dialog.show();
	}

	display_entries(wrap, entries, empty_message) {
		const me = this;
		if (entries && entries.length > 0) {
			wrap.append(frappe.render_template("linked_payment_header"));
			entries.forEach(entry => {
				entry.btn_class = "btn-primary";
				if (entry.posting_date && entry.posting_date > me.data.date) {
					entry.btn_class = "btn-warning";
				}
				me.prepare_display_fields(entry);
				wrap.append(frappe.render_template("linked_payment_row", entry));
				if (!entry.subentries) {
					return;
				}
				entry.subentries.forEach(subentry => {
					subentry.display_name = " > " + subentry.name;
					subentry.btn_class = "btn-info";
					me.prepare_display_fields(subentry);
					wrap.append(frappe.render_template("linked_payment_row", subentry));
				});
			});
		} else {
			wrap.append(`<div class="text-center"><h5 class="text-muted">${empty_message}</h5></div>`);
		}
	}

	prepare_display_fields(payment) {
		payment.display_name = payment.display_name || payment.name || "";
		payment.display_date = payment.reference_date ? frappe.datetime.str_to_user(payment.reference_date) : "";
		if (!payment.display_date) {
			payment.display_date = payment.posting_date ? frappe.datetime.str_to_user(payment.posting_date) : "";
		}
		payment.link_open = "";
		payment.link_close = "";
		if (payment.link_type) {
			payment.link_open = `<a href="${frappe.utils.get_form_link(payment.link_type, payment.display_name)}">`;
			payment.link_close = "</a>";
		}
		payment.display_party = payment.party || payment.party2 || payment.party3 || "";
		payment.display_reference = payment.reference_no || payment.ref2 || payment.ref3 || payment.ref4 || payment.ref5 || "";
	}

	display_payment_details(event) {
		const me = this;
		if (!(event.value)) {
			return;
		}
		const details_wrapper = this.dialog.fields_dict.payment_details.$wrapper;
		details_wrapper.empty();
		me.generate_detail_docs(event.value).then(detail_docs => {
			me.display_entries(details_wrapper, detail_docs,
				__("No payments found associated with ") + event.value
			);
		});
	}

	async generate_detail_docs(doc_name) {
		const me = this;
		let dt = me.dialog.fields_dict.payment_doctype.value;
		let displayed_docs = [];
		let doc = 0;
		if (dt === "Journal Entry") {
			doc = await frappe.db.get_doc("Journal Entry", doc_name);
			let total_amount = 0.0;
			doc.accounts.forEach(payment => {
				if (payment.account === me.gl_account && !payment.clearance_date) {
					payment.doctype = "Journal Entry Account";
					payment.posting_date = doc.posting_date;
					payment.party2 = payment.party;
					payment.party = doc.pay_to_recd_from;
					payment.party3 = payment.against_account;
					payment.reference_no = doc.cheque_no;
					payment.ref2 = payment.user_remark;
					payment.ref3 = doc.user_remark;
					payment.ref4 = doc.remark;
					payment.ref5 = payment.reference_name;
					payment.reference_date = doc.cheque_date;
					payment.currency = payment.account_currency;
					payment.pymt_amount = me.data.credit > 0 ? payment.debit-payment.credit : payment.credit-payment.debit;
					total_amount += payment.pymt_amount;
					payment.display_name = doc.name;
					displayed_docs.push(payment);
				}
			});
			if (displayed_docs.length > 1) {
				doc.doctype = "Journal Entry";
				doc.link_type = "Journal Entry";
				doc.display_name = doc.name;
				doc.party = doc.pay_to_recd_from;
				doc.reference_no = doc.cheque_no;
				doc.reference_date = doc.cheque_date;
				doc.currency = displayed_docs[1].currency;
				doc.pymt_amount = total_amount;
				doc.subentries = displayed_docs;
				return [doc];
			}
			if (displayed_docs.length == 1) {
				displayed_docs[0].link_type = "Journal Entry";
			}
			return displayed_docs;
		}
		if (dt === "Sales Invoice") {
			doc = await frappe.db.get_doc("Sales Invoice", doc_name);
			let total_amount = 0.0;
			doc.payments.forEach(payment => {
				if (payment.account === me.gl_account && !payment.clearance_date ) {
					payment.doctype = "Sales Invoice Payment";
					payment.posting_date = doc.posting_date;
					payment.party = doc.customer;
					payment.reference_no = doc.remarks;
					payment.ref2 = doc.po_no;
					payment.currency = doc.currency;
					payment.pymt_amount = payment.amount;
					total_amount += payment.pymt_amount;
					payment.display_name = doc.name;
					displayed_docs.push(payment);
				}
			});
			doc.party = doc.customer_name;
			doc.reference_no = doc.remarks;
			doc.pymt_amount = total_amount;
			if (displayed_docs.length > 1) {
				doc.subentries = displayed_docs;
				doc.link_type = "Sales Invoice";
				return [doc];
			} else if (displayed_docs.length == 1) {
				displayed_docs[0].link_type = "Sales Invoice";
				return displayed_docs;
			}
			// else no internal Sales Invoice Payment lines. So maybe there are
			// associated Payment Entry records; drop through and the code below
			// will handle that case.
		}
		if (dt === "Purchase Invoice") {
			doc = await frappe.db.get_doc("Purchase Invoice", doc_name);
			doc.pymt_amount = doc.paid_amount;
			doc.party = doc.supplier_name;
			doc.reference_no = doc.bill_no;
			doc.display_name = doc.name;
			doc.link_type = "Purchase Invoice";
			if (doc.cash_bank_account === me.gl_account) {
				return [doc];
			}
			// else there may be associated Payment Entry records; drop through
			// and the code below will handle that case.
		}
		let pay_ents = [];
		if (dt === "Payment Entry") {
			pay_ents.push(await frappe.db.get_doc("Payment Entry", doc_name));
		} else {
			pay_ents = await frappe.db.get_list("Payment Entry", {
				filters: {"reference_name": doc_name},
				fields: [
					"name", "payment_type", "paid_to",
					"paid_to_account_currency", "paid_from",
					"paid_from_account_currency",
					"posting_date", "party as party2",
					"party_name as party", "reference_no",
					"remarks as ref2", "reference_date",
					"paid_amount", "received_amount"
				]
			});
		}
		let total_amount = 0.0;
		pay_ents.forEach(payment => {
			if (payment.clearance_date) {
				return; // works like continue in this context
			}
			if (payment.paid_to === me.gl_account) {
				// Should we assert here that the payment_type is "Receive" or does it
				// not matter?
				payment.currency = payment.paid_to_account_currency;
				payment.pymt_amount = payment.received_amount;
			} else if (payment.paid_from === me.gl_account) {
				payment.currency = payment.paid_from_account_currency;
				payment.pymt_amount = payment.paid_amount;
			} else {
				// Somehow the account doesn't match at all
				return;
			}
			payment.doctype = "Payment Entry";
			payment.link_type = "Payment Entry";
			total_amount += payment.pymt_amount;
			displayed_docs.push(payment);
		});
		if (displayed_docs.length < 2) {
			return displayed_docs;
		}
		if (!doc) {
			doc = await frappe.db.get_doc(dt, doc_name);
			if (dt === "Expense Claim") {
				doc.party = doc.employee_name;
			}
			doc.display_name = name;
		}
		doc.pymt_amount = total_amount;
		doc.link_type = doc.doctype;
		doc.subentries = displayed_docs;
		return [doc];
	}
}
