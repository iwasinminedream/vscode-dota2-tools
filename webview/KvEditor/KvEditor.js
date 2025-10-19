const vscode = acquireVsCodeApi();

const fileNameEl = document.getElementById('kv-file-name');
const fileMetaEl = document.getElementById('kv-file-meta');
const tableSection = document.getElementById('kv-table');
const emptySection = document.getElementById('kv-empty');
const errorSection = document.getElementById('kv-error');
const formulaAddressInput = document.getElementById('kv-editor-address');
const formulaValueInput = document.getElementById('kv-editor-value');

if (emptySection) {
	emptySection.textContent = 'Loading KV data...';
}
setSectionVisibility({ showTable: false, showEmpty: true, showError: false });

const COLUMN_MIN_WIDTH = 100;
const ROW_NUMBER_COLUMN_KEY = '__rowNumber';
const ROW_NUMBER_MIN_WIDTH = 56;

let latestPayload = undefined;
let activeCell = undefined;
const columnWidths = Object.create(null);

let selectedCellKey = undefined;
let selectedCell = undefined;
let selectedTd = undefined;
let suppressFormulaCommit = false;
let columnOptionConfig = Object.create(null);

let resizeState = null;
let openMultiSelectContext = null;
let pendingMultiSelectReopen = null;

document.addEventListener('mousemove', handleColumnResize);
document.addEventListener('mouseup', stopColumnResize);

if (formulaValueInput) {
	formulaValueInput.addEventListener('input', () => {
		if (!selectedCell || !selectedCell.editable || !selectedCell.element || selectedCell.usesDropdown) {
			return;
		}
		setElementValue(selectedCell.element, formulaValueInput.value ?? '', selectedCell.fieldConfig);
	});
	formulaValueInput.addEventListener('keydown', (event) => {
		if (event.key === 'Enter') {
			event.preventDefault();
			commitFormulaValue();
			if (selectedCell?.element instanceof HTMLInputElement) {
				selectedCell.element.focus();
				selectedCell.element.select();
			}
		} else if (event.key === 'Escape') {
			event.preventDefault();
			revertFormulaValue();
			suppressFormulaCommit = true;
			formulaValueInput.blur();
		}
	});
	formulaValueInput.addEventListener('blur', () => {
		if (suppressFormulaCommit) {
			suppressFormulaCommit = false;
			return;
		}
		commitFormulaValue();
	});
}

// 根据给定状态切换表格、空白提示和错误提示的显示
function setSectionVisibility({ showTable, showEmpty, showError }) {
	if (tableSection) {
		tableSection.hidden = !showTable;
	}
	if (emptySection) {
		emptySection.hidden = !showEmpty;
	}
	if (errorSection) {
		errorSection.hidden = !showError;
	}
}

// 清空当前选中单元格及其公式编辑器状态
function clearSelection() {
	closeMultiSelectDropdown();
	if (selectedTd && selectedTd.classList) {
		selectedTd.classList.remove('kv-cell-selected');
	}
	selectedTd = undefined;
	selectedCell = undefined;
	selectedCellKey = undefined;
	if (formulaAddressInput) {
		formulaAddressInput.value = '';
		formulaAddressInput.title = '';
	}
	if (formulaValueInput) {
		formulaValueInput.value = '';
		formulaValueInput.disabled = true;
		formulaValueInput.placeholder = '选择单元格以编辑';
	}
}

// 选中指定单元格并同步公式栏信息
function selectCell(td, context) {
	if (!td) {
		clearSelection();
		return;
	}
	if (openMultiSelectContext && openMultiSelectContext.td !== td) {
		closeMultiSelectDropdown();
	}
	if (selectedTd && selectedTd !== td) {
		selectedTd.classList.remove('kv-cell-selected');
	}
	selectedTd = td;
	td.classList.add('kv-cell-selected');
	selectedCell = {
		column: context.column,
		columnLetter: context.columnLetter,
		columnName: context.columnName,
		rowId: context.rowId,
		rowIndex: context.rowIndex,
		editable: context.editable,
		element: context.element ?? null,
		fieldConfig: context.fieldConfig,
		usesDropdown: Boolean(context.usesDropdown)
	};
	selectedCellKey = {
		column: context.column,
		rowId: context.rowId,
		rowIndex: context.rowIndex
	};
	if (formulaAddressInput) {
		const rowLabel = context.rowIndex + 1;
		const columnLabel = context.columnLetter ?? context.column;
		const address = `${columnLabel}${rowLabel}`;
		formulaAddressInput.value = address;
		const columnName = context.columnName || context.column;
		formulaAddressInput.title = columnName ? `${columnName} · ${address}` : address;
	}
	if (formulaValueInput) {
		const disableFormulaInput = !context.editable || Boolean(context.usesDropdown);
		formulaValueInput.disabled = disableFormulaInput;
		formulaValueInput.placeholder = disableFormulaInput && context.editable ? '请通过下拉选择' : '';
		formulaValueInput.value = context.value ?? '';
	}
}

// 还原公式栏内容到单元格初始值
function revertFormulaValue() {
	if (!selectedCell || !selectedCell.element) {
		return;
	}
	const original = selectedCell.element.dataset.initialValue ?? '';
	setElementValue(selectedCell.element, original, selectedCell.fieldConfig);
	if (formulaValueInput) {
		formulaValueInput.value = original;
	}
}

// 将公式栏的修改写回选中单元格
function commitFormulaValue() {
	if (!selectedCell || !selectedCell.editable || !selectedCell.element || !formulaValueInput) {
		return;
	}
	if (selectedCell.usesDropdown) {
		return;
	}
	const newValue = formulaValueInput.value ?? '';
	const current = readElementValue(selectedCell.element, selectedCell.fieldConfig);
	const initial = selectedCell.element.dataset.initialValue ?? '';
	if (current === newValue && initial === newValue) {
		return;
	}
	setElementValue(selectedCell.element, newValue, selectedCell.fieldConfig);
	handleElementChange(selectedCell.element, selectedCell.fieldConfig);
}

// 获取字段配置中定义的分隔符
function getFieldSeparator(fieldConfig) {
	const separator = fieldConfig?.separator ?? ',';
	return typeof separator === 'string' && separator.length > 0 ? separator : ',';
}

// 将多选字段的原始文本拆分为值列表
function splitMultiValue(value, fieldConfig) {
	const separator = getFieldSeparator(fieldConfig);
	if (!value || typeof value !== 'string') {
		return [];
	}
	return value
		.split(separator)
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
}

// 从输入控件读取当前值
function readElementValue(element, fieldConfig) {
	if (!element) {
		return '';
	}
	if (element instanceof HTMLSelectElement && fieldConfig?.multiple) {
		const separator = getFieldSeparator(fieldConfig);
		const selectedValues = Array.from(element.selectedOptions).map((option) => option.value);
		return selectedValues.join(separator);
	}
	return element.value ?? '';
}

// 将指定值写入输入控件
function setElementValue(element, value, fieldConfig) {
	if (!element) {
		return;
	}
	if (element instanceof HTMLSelectElement) {
		if (fieldConfig?.multiple) {
			const selectedSet = new Set(splitMultiValue(value, fieldConfig));
			Array.from(element.options).forEach((option) => {
				option.selected = selectedSet.has(option.value);
			});
		} else {
			element.value = value ?? '';
		}
	} else {
		element.value = value ?? '';
	}
}

// 处理单元格数据变动并通知扩展端
function handleElementChange(element, fieldConfig) {
	if (!element) {
		return;
	}
	const id = element.dataset.id;
	const key = element.dataset.key;
	if (!id || !key) {
		return;
	}
	const currentValue = readElementValue(element, fieldConfig);
	const previous = element.dataset.initialValue ?? '';
	if (previous === currentValue) {
		return;
	}
	element.dataset.initialValue = currentValue;
	element.title = currentValue;
	vscode.postMessage({
		type: 'edit',
		payload: { id, key, value: currentValue }
	});
	if (selectedCell && selectedCell.element === element && formulaValueInput) {
		formulaValueInput.value = currentValue;
	}
}

// 获取多选项的显示文案
function getOptionLabel(fieldConfig, value) {
	return fieldConfig?.options?.find((option) => option.value === value)?.label ?? value;
}

// 渲染多选下拉的标签展示
function updateSelectDisplay(select, display, fieldConfig) {
	if (!display) {
		return;
	}
	display.innerHTML = '';
	const isMulti = Boolean(fieldConfig?.multiple);
	const rawValue = readElementValue(select, fieldConfig);
	const values = isMulti
		? splitMultiValue(rawValue, fieldConfig)
		: rawValue
			? [rawValue]
			: [];
	if (!values.length) {
		const placeholder = document.createElement('span');
		placeholder.className = 'kv-select-placeholder';
		placeholder.textContent = '未选择';
		display.appendChild(placeholder);
		return;
	}
	values.forEach((value) => {
		const tag = document.createElement('span');
		tag.className = 'kv-select-tag';
		tag.textContent = getOptionLabel(fieldConfig, value);
		display.appendChild(tag);
	});
}

// 根据当前值刷新多选浮层的选中状态
function updateMultiSelectOverlaySelection() {
	if (!openMultiSelectContext) {
		return;
	}
	const { overlay, select, fieldConfig } = openMultiSelectContext;
	const selectedSet = new Set(splitMultiValue(readElementValue(select, fieldConfig), fieldConfig));
	const optionNodes = overlay.querySelectorAll('.kv-multiselect-option');
	optionNodes.forEach((node) => {
		const value = node.dataset.value ?? '';
		if (selectedSet.has(value)) {
			node.classList.add('kv-multiselect-option-checked');
		} else {
			node.classList.remove('kv-multiselect-option-checked');
		}
	});
}

// 切换多选浮层中某个选项的勾选状态
function toggleMultiSelectOption(value) {
	if (!openMultiSelectContext) {
		return;
	}
	const { select, fieldConfig, display, td } = openMultiSelectContext;
	const currentValues = splitMultiValue(readElementValue(select, fieldConfig), fieldConfig);
	const selectedSet = new Set(currentValues);
	if (selectedSet.has(value)) {
		selectedSet.delete(value);
	} else {
		selectedSet.add(value);
	}
	const orderedValues = (fieldConfig?.options ?? [])
		.map((option) => option.value)
		.filter((optionValue) => selectedSet.has(optionValue));
	const separator = getFieldSeparator(fieldConfig);
	const newValue = orderedValues.join(separator);
	const rowId = select.dataset.id ?? '';
	const columnKey = select.dataset.key ?? '';
	const rowIndex = td?.dataset.rowIndex ?? '';
	pendingMultiSelectReopen = { column: columnKey, rowId, rowIndex };
	setElementValue(select, newValue, fieldConfig);
	handleElementChange(select, fieldConfig);
	updateSelectDisplay(select, display, fieldConfig);
	updateMultiSelectOverlaySelection();
}

// 关闭多选浮层并清理监听
function closeMultiSelectDropdown(options) {
	if (!openMultiSelectContext) {
		return;
	}
	const preservePending = Boolean(options?.preservePending);
	const { overlay, outsideHandler, keyHandler, scrollHandler, resizeHandler } = openMultiSelectContext;
	overlay.remove();
	document.removeEventListener('mousedown', outsideHandler, true);
	document.removeEventListener('keydown', keyHandler);
	if (tableSection) {
		tableSection.removeEventListener('scroll', scrollHandler);
	}
	window.removeEventListener('resize', resizeHandler);
	openMultiSelectContext = null;
	if (!preservePending) {
		pendingMultiSelectReopen = null;
	}
}

// 打开多选浮层并绑定事件
function openMultiSelectDropdown(context) {
	if (!tableSection || !context || !context.fieldConfig) {
		return;
	}
	if (openMultiSelectContext) {
		if (openMultiSelectContext.td === context.td) {
			updateMultiSelectOverlaySelection();
			openMultiSelectContext.reposition();
			return;
		}
		closeMultiSelectDropdown();
	}
	const overlay = document.createElement('div');
	overlay.className = 'kv-multiselect-overlay';
	const optionContainer = document.createElement('div');
	context.fieldConfig.options?.forEach((option) => {
		const optionEl = document.createElement('div');
		optionEl.className = 'kv-multiselect-option';
		optionEl.dataset.value = option.value;
		const labelSpan = document.createElement('span');
		labelSpan.textContent = option.label;
		const checkSpan = document.createElement('span');
		checkSpan.className = 'kv-multiselect-option-check';
		checkSpan.textContent = '✔';
		optionEl.appendChild(labelSpan);
		optionEl.appendChild(checkSpan);
		optionEl.addEventListener('mousedown', (event) => {
			event.preventDefault();
		});
		optionEl.addEventListener('click', (event) => {
			event.preventDefault();
			toggleMultiSelectOption(option.value);
		});
		optionContainer.appendChild(optionEl);
	});
	overlay.appendChild(optionContainer);
	tableSection.appendChild(overlay);
	const reposition = () => {
		const tableRect = tableSection.getBoundingClientRect();
		const cellRect = context.td.getBoundingClientRect();
		const top = cellRect.bottom - tableRect.top + tableSection.scrollTop;
		const left = cellRect.left - tableRect.left + tableSection.scrollLeft;
		overlay.style.top = `${top}px`;
		overlay.style.left = `${left}px`;
		overlay.style.minWidth = `${cellRect.width}px`;
	};
	const outsideHandler = (event) => {
		if (!overlay.contains(event.target) && !context.td.contains(event.target)) {
			closeMultiSelectDropdown();
		}
	};
	const keyHandler = (event) => {
		if (event.key === 'Escape') {
			event.preventDefault();
			closeMultiSelectDropdown();
		}
	};
	const scrollHandler = () => reposition();
	const resizeHandler = () => reposition();
	document.addEventListener('mousedown', outsideHandler, true);
	document.addEventListener('keydown', keyHandler);
	tableSection.addEventListener('scroll', scrollHandler);
	window.addEventListener('resize', resizeHandler);
	reposition();
	openMultiSelectContext = {
		overlay,
		select: context.select,
		display: context.display,
		fieldConfig: context.fieldConfig,
		td: context.td,
		reposition,
		outsideHandler,
		keyHandler,
		scrollHandler,
		resizeHandler
	};
	updateMultiSelectOverlaySelection();
}

// 计算列的最小宽度
function getMinColumnWidth(column) {
	return column === ROW_NUMBER_COLUMN_KEY ? ROW_NUMBER_MIN_WIDTH : COLUMN_MIN_WIDTH;
}

// 获取列的当前宽度（含初次估算）
function getColumnWidth(column, headerText) {
	if (columnWidths[column]) {
		return columnWidths[column];
	}
	if (column === ROW_NUMBER_COLUMN_KEY) {
		columnWidths[column] = ROW_NUMBER_MIN_WIDTH;
		return columnWidths[column];
	}
	const labelLength = Math.max((headerText ?? '').length, 4);
	const estimated = Math.max(COLUMN_MIN_WIDTH, labelLength * 12);
	columnWidths[column] = estimated;
	return estimated;
}

// 将列索引转换为字母标记
function getColumnLetter(index) {
	let dividend = index + 1;
	let columnName = '';
	while (dividend > 0) {
		const modulo = (dividend - 1) % 26;
		columnName = String.fromCharCode(65 + modulo) + columnName;
		dividend = Math.floor((dividend - modulo) / 26);
	}
	return columnName;
}

// 根据列宽重算整表宽度
function refreshTableWidth() {
	if (!tableSection) {
		return;
	}
	const table = tableSection.querySelector('table');
	if (!table) {
		return;
	}
	let totalWidth = 0;
	const colElements = table.querySelectorAll('col[data-column]');
	colElements.forEach((col) => {
		const column = col.getAttribute('data-column');
		if (!column) {
			return;
		}
		const headerLabel = column === ROW_NUMBER_COLUMN_KEY ? '#' : column;
		const width = columnWidths[column] ?? getColumnWidth(column, headerLabel);
		totalWidth += width;
	});
	const fallbackWidth = tableSection.clientWidth || totalWidth;
	table.style.minWidth = `${totalWidth}px`;
	table.style.width = `${Math.max(totalWidth, fallbackWidth)}px`;
}

// 更新指定列的宽度并刷新布局
function updateColumnWidth(column, width) {
	const adjusted = Math.max(getMinColumnWidth(column), width);
	columnWidths[column] = adjusted;
	if (!tableSection) {
		return;
	}
	const colElement = tableSection.querySelector(`col[data-column="${column}"]`);
	if (colElement) {
		colElement.style.width = `${adjusted}px`;
	}
	const headerCell = tableSection.querySelector(`th[data-column="${column}"]`);
	if (headerCell) {
		headerCell.style.width = `${adjusted}px`;
	}
	const dataCells = tableSection.querySelectorAll(`td[data-column="${column}"]`);
	dataCells.forEach((cell) => {
		cell.style.width = `${adjusted}px`;
	});
	refreshTableWidth();
}

// 开始列宽拖拽操作
function startColumnResize(event, column) {
	if (!tableSection) {
		return;
	}
	const colElement = tableSection.querySelector(`col[data-column="${column}"]`);
	if (!colElement) {
		return;
	}
	event.preventDefault();
	resizeState = {
		column,
		startX: event.clientX,
		startWidth: colElement.getBoundingClientRect().width
	};
	document.body.classList.add('kv-resizing');
}

// 拖拽过程中实时调整列宽
function handleColumnResize(event) {
	if (!resizeState) {
		return;
	}
	const delta = event.clientX - resizeState.startX;
	const newWidth = Math.max(getMinColumnWidth(resizeState.column), resizeState.startWidth + delta);
	updateColumnWidth(resizeState.column, newWidth);
}

// 结束列宽拖拽并清理状态
function stopColumnResize() {
	if (!resizeState) {
		return;
	}
	resizeState = null;
	document.body.classList.remove('kv-resizing');
}

// 重新聚焦此前活跃的输入控件
function restoreActiveCell() {
	if (!activeCell) {
		return;
	}
	const selector = `[data-id="${activeCell.id}"][data-key="${activeCell.key}"]`;
	const focusTarget = tableSection?.querySelector(selector);
	if (focusTarget instanceof HTMLInputElement) {
		const length = focusTarget.value.length;
		focusTarget.focus();
		focusTarget.setSelectionRange(length, length);
	} else if (focusTarget instanceof HTMLSelectElement) {
		const styles = window.getComputedStyle(focusTarget);
		if (styles.display !== 'none' && styles.visibility !== 'hidden') {
			focusTarget.focus();
		}
	}
}

// 渲染后恢复之前的单元格选中状态
function restoreSelection(columnLabels, columnLetters, columnOptions) {
	if (!selectedCellKey) {
		return;
	}
	const selector = `td[data-column="${selectedCellKey.column}"][data-row-index="${String(selectedCellKey.rowIndex ?? 0)}"]`;
	const td = tableSection?.querySelector(selector);
	if (!td) {
		clearSelection();
		return;
	}
	const rowIndex = Number(td.dataset.rowIndex ?? '0');
	const columnName = columnLabels.get(selectedCellKey.column) ?? selectedCellKey.column;
	const columnLetter = columnLetters.get(selectedCellKey.column) ?? selectedCellKey.column;
	const editable = selectedCellKey.column !== ROW_NUMBER_COLUMN_KEY && selectedCellKey.column !== 'id';
	const fieldConfig = columnOptions[selectedCellKey.column];
	const usesDropdown = Boolean(fieldConfig?.options?.length);
	let element = null;
	if (editable) {
		element = usesDropdown ? td.querySelector('select') : td.querySelector('input');
	}
	const value = editable ? readElementValue(element, fieldConfig) : (td.textContent ?? '');
	const rowId = td.dataset.rowId ?? '';
	selectCell(td, {
		column: selectedCellKey.column,
		columnLetter,
		columnName,
		rowId,
		rowIndex,
		editable,
		element,
		fieldConfig,
		usesDropdown,
		value
	});
}

// 渲染主表格结构和单元格控件
function renderTable(columns, rows, columnOptions) {
	if (!tableSection) {
		return;
	}
	let preservePending = Boolean(pendingMultiSelectReopen);
	if (!preservePending && openMultiSelectContext) {
		const reopenColumn = openMultiSelectContext.select?.dataset.key ?? '';
		const reopenRowId = openMultiSelectContext.select?.dataset.id ?? '';
		const reopenRowIndex = openMultiSelectContext.td?.dataset.rowIndex ?? '';
		if (reopenColumn && reopenRowId) {
			pendingMultiSelectReopen = {
				column: reopenColumn,
				rowId: reopenRowId,
				rowIndex: reopenRowIndex
			};
			preservePending = true;
		}
	}
	closeMultiSelectDropdown({ preservePending });
	const displayColumns = [ROW_NUMBER_COLUMN_KEY, ...columns];
	const table = document.createElement('table');
	const colgroup = document.createElement('colgroup');
	const columnLabels = new Map();
	const columnLetters = new Map();
	columns.forEach((column, index) => {
		columnLetters.set(column, getColumnLetter(index));
	});
	columnLetters.set(ROW_NUMBER_COLUMN_KEY, '#');
	for (const column of displayColumns) {
		const headerLabel = column === ROW_NUMBER_COLUMN_KEY ? '#' : column;
		columnLabels.set(column, headerLabel);
		const width = getColumnWidth(column, headerLabel);
		const colElement = document.createElement('col');
		colElement.dataset.column = column;
		colElement.style.width = `${width}px`;
		colgroup.appendChild(colElement);
	}
	table.appendChild(colgroup);
	const thead = document.createElement('thead');
	const headRow = document.createElement('tr');
	for (const column of displayColumns) {
		const th = document.createElement('th');
		const headerLabel = columnLabels.get(column) ?? column;
		th.dataset.column = column;
		th.style.width = `${getColumnWidth(column, headerLabel)}px`;
		th.style.minWidth = `${getMinColumnWidth(column)}px`;
		if (column === ROW_NUMBER_COLUMN_KEY) {
			th.textContent = '#';
		} else {
			const wrapper = document.createElement('div');
			wrapper.className = 'kv-column-header';
			const letterEl = document.createElement('span');
			letterEl.className = 'kv-column-letter';
			letterEl.textContent = columnLetters.get(column) ?? '';
			const nameEl = document.createElement('span');
			nameEl.className = 'kv-column-name';
			nameEl.textContent = headerLabel;
			nameEl.title = headerLabel;
			wrapper.appendChild(letterEl);
			wrapper.appendChild(nameEl);
			th.appendChild(wrapper);
		}
		const resizer = document.createElement('div');
		resizer.className = 'kv-resizer';
		resizer.addEventListener('mousedown', (event) => startColumnResize(event, column));
		th.appendChild(resizer);
		headRow.appendChild(th);
	}
	thead.appendChild(headRow);
	const tbody = document.createElement('tbody');
	rows.forEach((row, rowIndex) => {
		const tr = document.createElement('tr');
		for (const column of displayColumns) {
			const td = document.createElement('td');
			td.dataset.column = column;
			td.dataset.rowId = row.id ?? '';
			td.dataset.rowIndex = String(rowIndex);
			td.style.width = `${getColumnWidth(column, columnLabels.get(column) ?? column)}px`;
			const columnLetter = columnLetters.get(column) ?? column;
			const columnName = columnLabels.get(column) ?? column;
			const fieldConfig = columnOptions?.[column];
			const usesDropdown = Boolean(fieldConfig?.options?.length);
			if (column === ROW_NUMBER_COLUMN_KEY) {
				td.textContent = String(rowIndex + 1);
				td.classList.add('kv-row-index');
				td.addEventListener('click', () => {
					selectCell(td, {
						column,
						columnLetter,
						columnName,
						rowId: row.id ?? '',
						rowIndex,
						editable: false,
						element: null,
						fieldConfig: undefined,
						usesDropdown: false,
						value: td.textContent ?? ''
					});
				});
			} else if (column === 'id') {
				td.textContent = row.id ?? '';
				td.classList.add('kv-cell-id');
				td.addEventListener('click', () => {
					selectCell(td, {
						column,
						columnLetter,
						columnName,
						rowId: row.id ?? '',
						rowIndex,
						editable: false,
						element: null,
						fieldConfig: undefined,
						usesDropdown: false,
						value: row.id ?? ''
					});
				});
			} else {
				const value = row.values?.[column] ?? '';
				if (usesDropdown) {
					const select = document.createElement('select');
					select.dataset.id = row.id ?? '';
					select.dataset.key = column;
					const isMultiSelect = Boolean(fieldConfig?.multiple);
					if (isMultiSelect) {
						select.multiple = true;
					}
					fieldConfig?.options.forEach((option) => {
						const optionEl = document.createElement('option');
						optionEl.value = option.value;
						optionEl.textContent = option.label;
						select.appendChild(optionEl);
					});
					setElementValue(select, value, fieldConfig);
					const initialValue = readElementValue(select, fieldConfig);
					select.dataset.initialValue = initialValue;
					select.title = initialValue;
					const container = document.createElement('div');
					container.className = 'kv-select-cell';
					const display = document.createElement('div');
					display.className = 'kv-select-display';
					container.appendChild(display);
					container.appendChild(select);
					select.classList.add('kv-select-hidden');
					updateSelectDisplay(select, display, fieldConfig);
					td.appendChild(container);
					if (isMultiSelect) {
						const updateSelection = () => {
							const currentValue = readElementValue(select, fieldConfig);
							activeCell = { id: row.id ?? '', key: column };
							selectCell(td, {
								column,
								columnLetter,
								columnName,
								rowId: row.id ?? '',
								rowIndex,
								editable: true,
								element: select,
								fieldConfig,
								usesDropdown: true,
								value: currentValue
							});
						};
						select.addEventListener('change', () => {
							handleElementChange(select, fieldConfig);
							updateSelectDisplay(select, display, fieldConfig);
						});
						td.addEventListener('click', () => {
							updateSelection();
						});
						td.addEventListener('dblclick', () => {
							updateSelection();
							openMultiSelectDropdown({ td, select, display, fieldConfig });
						});
					} else {
						const updateSelection = () => {
							const currentValue = readElementValue(select, fieldConfig);
							selectCell(td, {
								column,
								columnLetter,
								columnName,
								rowId: row.id ?? '',
								rowIndex,
								editable: true,
								element: select,
								fieldConfig,
								usesDropdown: true,
								value: currentValue
							});
						};
						const showSelect = () => {
							select.classList.remove('kv-select-hidden');
							container.classList.add('kv-select-editing');
							select.focus();
						};
						select.addEventListener('focus', () => {
							activeCell = { id: row.id ?? '', key: column };
							updateSelection();
						});
						select.addEventListener('blur', () => {
							activeCell = undefined;
							select.classList.add('kv-select-hidden');
							container.classList.remove('kv-select-editing');
						});
						select.addEventListener('change', () => {
							handleElementChange(select, fieldConfig);
							updateSelectDisplay(select, display, fieldConfig);
							select.blur();
						});
						select.addEventListener('keydown', (event) => {
							if (event.key === 'Escape') {
								event.preventDefault();
								const original = select.dataset.initialValue ?? '';
								setElementValue(select, original, fieldConfig);
								select.blur();
							}
						});
						td.addEventListener('click', () => {
							updateSelection();
						});
						td.addEventListener('dblclick', () => {
							updateSelection();
							showSelect();
						});
					}
				} else {
					const input = document.createElement('input');
					input.type = 'text';
					input.dataset.id = row.id ?? '';
					input.dataset.key = column;
					setElementValue(input, value, undefined);
					input.dataset.initialValue = input.value ?? '';
					input.title = input.value;
					const updateSelection = () => {
						selectCell(td, {
							column,
							columnLetter,
							columnName,
							rowId: row.id ?? '',
							rowIndex,
							editable: true,
							element: input,
							fieldConfig: undefined,
							usesDropdown: false,
							value: input.value
						});
					};
					input.addEventListener('focus', () => {
						activeCell = { id: row.id ?? '', key: column };
						updateSelection();
					});
					input.addEventListener('blur', () => {
						activeCell = undefined;
					});
					input.addEventListener('change', () => {
						handleElementChange(input, undefined);
					});
					input.addEventListener('mousedown', (event) => {
						if (event.detail === 1) {
							event.preventDefault();
							updateSelection();
						}
					});
					input.addEventListener('keydown', (event) => {
						if (event.key === 'Enter') {
							event.preventDefault();
							event.currentTarget?.blur();
						} else if (event.key === 'Escape') {
							event.preventDefault();
							const original = input.dataset.initialValue ?? '';
							setElementValue(input, original, undefined);
							input.blur();
						}
					});
					td.appendChild(input);
					td.addEventListener('click', (event) => {
						if (event.target instanceof HTMLInputElement) {
							return;
						}
						updateSelection();
					});
					td.addEventListener('dblclick', () => {
						input.focus();
						input.select();
					});
				}
			}
			tr.appendChild(td);
		}
		tbody.appendChild(tr);
	});
	table.appendChild(thead);
	table.appendChild(tbody);
	tableSection.innerHTML = '';
	tableSection.appendChild(table);
	refreshTableWidth();
	restoreSelection(columnLabels, columnLetters, columnOptions);
	restoreActiveCell();
	if (pendingMultiSelectReopen) {
		const { column, rowIndex, rowId } = pendingMultiSelectReopen;
		let td = null;
		if (column !== undefined && rowIndex !== undefined && rowIndex !== '') {
			const selector = `td[data-column="${column}"][data-row-index="${rowIndex}"]`;
			td = tableSection.querySelector(selector);
		}
		if (!td && column !== undefined && rowId) {
			const safeRowId = typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(rowId) : rowId.replace(/"/g, '\\"');
			const selector = `td[data-column="${column}"][data-row-id="${safeRowId}"]`;
			td = tableSection.querySelector(selector);
		}
		const fieldConfig = columnOptions?.[column];
		const select = td?.querySelector('select');
		const display = td?.querySelector('.kv-select-display');
		if (td && select && display && fieldConfig?.multiple) {
			openMultiSelectDropdown({ td, select, display, fieldConfig });
		}
		pendingMultiSelectReopen = null;
	}
}

// 根据扩展端消息刷新整体界面
function render(payload) {
	if (!payload) {
		return;
	}
	latestPayload = payload;
	const metaParts = [];
	if (payload.folderType) {
		metaParts.push(`路径类型: ${payload.folderType}`);
	}
	if (payload.header) {
		metaParts.push(`根键: ${payload.header}`);
	}
	if (fileNameEl) {
		fileNameEl.textContent = payload.fileName || 'KV File';
	}
	if (fileMetaEl) {
		fileMetaEl.textContent = metaParts.join(' · ');
	}
	if (payload.error) {
		if (errorSection) {
			errorSection.textContent = payload.error;
		}
		clearSelection();
		setSectionVisibility({ showTable: false, showEmpty: false, showError: true });
		return;
	}
	if (errorSection) {
		errorSection.textContent = '';
	}
	columnOptionConfig = payload.columnOptions ? { ...payload.columnOptions } : Object.create(null);
	if (!payload.columns?.length || !payload.rows?.length) {
		if (emptySection) {
			emptySection.textContent = 'No flat entries found for this KV file.';
		}
		if (tableSection) {
			tableSection.innerHTML = '';
		}
		clearSelection();
		setSectionVisibility({ showTable: false, showEmpty: true, showError: false });
		return;
	}
	renderTable(payload.columns, payload.rows, columnOptionConfig);
	if (emptySection) {
		emptySection.textContent = '';
	}
	setSectionVisibility({ showTable: true, showEmpty: false, showError: false });
}

window.addEventListener('message', event => {
	const message = event.data;
	if (message?.type === 'update') {
		render(message.payload);
	}
});

vscode.postMessage({ type: 'ready' });