const vscode = acquireVsCodeApi();

const i18n = {
	"en": {
		propertyValue: "Property Values",
		value: "Value",
		description: "Description",
		example: "Example"
	},
	"zh-cn": {
		propertyValue: "属性值",
		value: "值",
		description: "描述",
		example: "范例"
	}
};
const uiLang = document.documentElement.lang || 'en';
const t = i18n[uiLang] || i18n['en'];

function renderCss(cssInfo) {
	console.log(cssInfo);
	let css = '';
	for (const key in cssInfo) {
		const element = cssInfo[key];
		css += `# ${key}
${element.description}
`;
		if (element.value && Object.keys(element.value).length > 0) {
			css += `## ${t.propertyValue}\n${t.value}|${t.description}\n--|--\n`;
			for (let value in element.value) {
				css += value.replace(/</, "\\\<").replace(/>/, "\\\>") + '|' + element.value[value].description + '\n';
			}
		}
		if (element.example) {
			css += `## ${t.example}
\`\`\`css
${element.example}
\`\`\`
`;
		}
	}
	document.querySelector('.markdown-body').innerHTML = marked(css);
}
window.addEventListener('message', event => {
	const message = event.data;
	vscode.setState({
		data: message.data,
	});
	renderCss(message.data);
});
(function () {
	const state = vscode.getState();
	if (state) {
	}
}());
