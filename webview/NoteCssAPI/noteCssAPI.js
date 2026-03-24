const vscode = acquireVsCodeApi();
let rootElement = document.querySelector('.markdown-body');

const i18n = {
	"en": {
		longDesc: "Long description",
		value: "Value",
		description: "Description",
		addItem: "Add item",
		removeItem: "Remove item",
		example: "Example",
		confirm: "Confirm"
	},
	"zh-cn": {
		longDesc: "长描述",
		value: "值",
		description: "描述",
		addItem: "添加项",
		removeItem: "删除项",
		example: "范例",
		confirm: "确认"
	}
};
const uiLang = document.documentElement.lang || 'en';
const t = i18n[uiLang] || i18n['en'];

function renderCssProperty(cssProperty) {
	rootElement.innerHTML = "";
	let titleElement = rootElement.createChild('h1', { text: cssProperty.class });
	// 描述
	let descriptionTitleElement = rootElement.createChild('h1', { text: "Description" });
	let descriptionElement = rootElement.createChild('pre');
	let textareaElement = descriptionElement.createChild('textarea', { className: 'list-object-value', placeholder: t.longDesc, type: 'text', rows: '1', text: cssProperty.description || cssProperty.description_lite || "" });
	// textarea自适应高度
	textareaElement.addEventListener('input', (event) => {
		event.target.style.height = event.target.scrollHeight + "px";
		cssProperty.description = event.target.value;
	});
	let paramsTitleElement = rootElement.createChild('h1', { text: "Parameters" });
	// 表头
	let tableElement = rootElement.createChild('table');
	let theadElement = tableElement.createChild('thead');
	let trElement = theadElement.createChild('tr');
	trElement.createChild('th', { text: t.value });
	trElement.createChild('th', { text: t.description });
	let tbodyElement = tableElement.createChild('tbody');
	for (const paramsName in cssProperty.value) {
		let trElement = tbodyElement.createChild('tr');
		const paramsInfo = cssProperty.value[paramsName];

		// trElement.createChild('td', { text: params_info.type });

		let typeTdElement = trElement.createChild('td');
		let typeInputElement = typeTdElement.createChild('input', { className: 'td-edit', value: paramsName });
		typeInputElement.addEventListener('input', (event) => {
			cssProperty.value[paramsName].type = event.target.value;
		});
		let descriptionTdElement = trElement.createChild('td');
		let descriptionInputElement = descriptionTdElement.createChild('input', { className: 'td-edit', value: paramsInfo.description });
		descriptionInputElement.addEventListener('input', (event) => {
			cssProperty.value[paramsName].description = event.target.value;
		});
	}
	let btnAddElement = rootElement.createChild('a', { className: 'monaco-text-button new-btn', text: t.addItem });
	btnAddElement.addEventListener('click', () => {
		let trElement = tbodyElement.createChild('tr');
		let valueTdElement = trElement.createChild('td');
		let valueInputElement = valueTdElement.createChild('input', { className: 'td-edit', value: "" });

		let descriptionTdElement = trElement.createChild('td');
		let descriptionInputElement = descriptionTdElement.createChild('input', { className: 'td-edit', value: "" });

	});
	let btnRemoveElement = rootElement.createChild('a', { className: 'monaco-text-button new-btn', text: t.removeItem });
	btnRemoveElement.addEventListener('click', () => {
		tbodyElement.removeChild(tbodyElement.lastChild);
	});
	// 范例
	let exampleTitleElement = rootElement.createChild('h1', { text: "Example" });
	let exampleElement = rootElement.createChild('pre');
	exampleTextareaElement = exampleElement.createChild('textarea', { className: 'list-object-value', placeholder: t.example, type: 'text', rows: '1', text: cssProperty.example || "" });
	exampleTextareaElement.style.height = exampleTextareaElement.scrollHeight + "px";
	// textarea自适应高度
	exampleTextareaElement.addEventListener('input', (event) => {
		event.target.style.height = event.target.scrollHeight + "px";
		cssProperty.example = event.target.value;
	});
	// 确认
	let btnConfirmElement = rootElement.createChild('a', { className: 'monaco-text-button', text: t.confirm });
	btnConfirmElement.addEventListener('click', () => {
		// console.log(cssProperty);
		cssProperty.value = {};
		for (let index = 0; index < tbodyElement.children.length; index++) {
			const element = tbodyElement.children[index];
			const key = element.children[0].children[0].value;
			const value = element.children[1].children[0].value;
			cssProperty.value[key] = { description: value };
		}
		vscode.postMessage({
			data: cssProperty
		});
	});
}
window.addEventListener('message', event => {
	const message = event.data;
	vscode.setState({
		data: message.data,
	});
	renderCssProperty(message.data);
});
(function () {
	const state = vscode.getState();
	if (state) {
	}
}());
