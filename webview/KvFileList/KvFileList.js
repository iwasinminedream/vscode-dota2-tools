const vscode = acquireVsCodeApi();

const folderNameEl = document.getElementById('kv-folder-name');
const folderPathEl = document.getElementById('kv-folder-path');
const refreshButton = document.getElementById('kv-refresh');
const emptySection = document.getElementById('kv-empty');
const tableWrapper = document.getElementById('kv-table-wrapper');

refreshButton?.addEventListener('click', () => {
	vscode.postMessage({ type: 'refresh' });
});

window.addEventListener('message', (event) => {
	const message = event.data;
	if (message?.type === 'update') {
		render(message.payload);
	}
});

window.addEventListener('DOMContentLoaded', () => {
	vscode.postMessage({ type: 'ready' });
});

function render(payload) {
	if (!payload) {
		return;
	}
	const { folderPath, rootPath, files, folderType } = payload;
	const folderName = extractFolderName(folderPath);
	folderNameEl.textContent = `${folderName} (${folderType})`;
	folderPathEl.textContent = folderPath;

	if (!files.length) {
		emptySection.hidden = false;
		tableWrapper.innerHTML = '';
		return;
	}

	emptySection.hidden = true;
	const table = document.createElement('table');
	table.innerHTML = `<thead>
		<tr>
			<th>Name</th>
			<th>Summary</th>
			<th>Size</th>
			<th>Modified</th>
		</tr>
	</thead>`;
	const tbody = document.createElement('tbody');
	for (const file of files) {
		const row = document.createElement('tr');

		const nameCell = document.createElement('td');
		const openButton = document.createElement('button');
		openButton.className = 'kv-open-button';
		openButton.textContent = file.name;
		openButton.addEventListener('click', (event) => {
			event.preventDefault();
			vscode.postMessage({ type: 'openFile', path: file.fullPath });
		});
		nameCell.appendChild(openButton);
		const pathInfo = document.createElement('div');
		pathInfo.className = 'kv-subtitle';
		pathInfo.textContent = file.relativePath || file.fullPath.replace(rootPath, '.');
		nameCell.appendChild(pathInfo);
		row.appendChild(nameCell);

		const summaryCell = document.createElement('td');
		summaryCell.className = 'kv-summary';
		summaryCell.textContent = file.summary.join('\n');
		row.appendChild(summaryCell);

		const sizeCell = document.createElement('td');
		sizeCell.textContent = formatSize(file.size);
		row.appendChild(sizeCell);

		const modifiedCell = document.createElement('td');
		modifiedCell.textContent = formatDate(file.mtime);
		row.appendChild(modifiedCell);

		tbody.appendChild(row);
	}
	table.appendChild(tbody);
	tableWrapper.innerHTML = '';
	tableWrapper.appendChild(table);
}

function extractFolderName(folderPath) {
	if (typeof folderPath !== 'string' || !folderPath.length) {
		return 'KV';
	}
	const normalized = folderPath.replace(/\\/g, '/');
	const parts = normalized.split('/').filter(Boolean);
	return parts.length ? parts[parts.length - 1] : folderPath;
}

function formatSize(size) {
	if (typeof size !== 'number') {
		return '';
	}
	if (size < 1024) {
		return `${size} B`;
	}
	if (size < 1024 * 1024) {
		return `${(size / 1024).toFixed(1)} KB`;
	}
	return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(value) {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) {
		return '';
	}
	return date.toLocaleString();
}
