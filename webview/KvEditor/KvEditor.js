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

const FOLDER_TYPE_LABELS = {
	ability: '技能',
	item: '物品',
	unit: '单位',
	custom: '自定义'
};

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

// 渲染下拉选择的标签展示
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

// 根据当前值刷新下拉浮层的选中状态
function updateMultiSelectOverlaySelection() {
	if (!openMultiSelectContext) {
		return;
	}
	const { select, fieldConfig, entries } = openMultiSelectContext;
	const selectedSet = new Set(splitMultiValue(readElementValue(select, fieldConfig), fieldConfig));
	(entries || []).forEach((entry) => {
		if (!entry || !entry.element) {
			return;
		}
		if (selectedSet.has(entry.option.value)) {
			entry.element.classList.add('kv-quickpick-item-checked');
		} else {
			entry.element.classList.remove('kv-quickpick-item-checked');
		}
	});
}

// 切换浮层中某个选项的勾选状态
function toggleMultiSelectOption(value) {
	if (!openMultiSelectContext) {
		return;
	}
	const { select, fieldConfig, display, td, isMulti } = openMultiSelectContext;
	if (isMulti) {
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
		if (openMultiSelectContext && openMultiSelectContext.focusSearch) {
			openMultiSelectContext.focusSearch();
		}
	} else {
		setElementValue(select, value, fieldConfig);
		handleElementChange(select, fieldConfig);
		updateSelectDisplay(select, display, fieldConfig);
		closeMultiSelectDropdown();
	}
}

// 关闭下拉浮层并清理监听
function closeMultiSelectDropdown(options) {
	if (!openMultiSelectContext) {
		return;
	}
	const preservePending = Boolean(options?.preservePending);
	const { overlay, outsideHandler, keyHandler, scrollHandler, resizeHandler, searchInput, searchHandlers } = openMultiSelectContext;
	overlay.remove();
	document.removeEventListener('mousedown', outsideHandler, true);
	document.removeEventListener('keydown', keyHandler);
	if (searchInput && searchHandlers) {
		if (searchHandlers.input) {
			searchInput.removeEventListener('input', searchHandlers.input);
		}
		if (searchHandlers.keydown) {
			searchInput.removeEventListener('keydown', searchHandlers.keydown);
		}
	}
	if (tableSection) {
		tableSection.removeEventListener('scroll', scrollHandler);
	}
	window.removeEventListener('resize', resizeHandler);
	openMultiSelectContext = null;
	if (!preservePending) {
		pendingMultiSelectReopen = null;
	}
}

// 打开下拉浮层并绑定事件
function openMultiSelectDropdown(context) {
	if (!tableSection || !context || !context.fieldConfig) {
		return;
	}
	const isMultiSelect = Boolean(context.fieldConfig?.multiple);
	if (openMultiSelectContext) {
		if (openMultiSelectContext.td === context.td) {
			updateMultiSelectOverlaySelection();
			openMultiSelectContext.reposition();
			return;
		}
		closeMultiSelectDropdown();
	}
	const overlay = document.createElement('div');
	overlay.className = 'kv-quickpick';
	const searchWrapper = document.createElement('div');
	searchWrapper.className = 'kv-quickpick-search-wrapper';
	const searchInput = document.createElement('input');
	searchInput.type = 'search';
	searchInput.className = 'kv-quickpick-search';
	const placeholderName = context.columnName ? ` ${context.columnName}` : '';
	searchInput.placeholder = `搜索${placeholderName}`.trim() || '搜索';
	searchWrapper.appendChild(searchInput);
	overlay.appendChild(searchWrapper);
	const list = document.createElement('div');
	list.className = 'kv-quickpick-list';
	overlay.appendChild(list);
	const emptyIndicator = document.createElement('div');
	emptyIndicator.className = 'kv-quickpick-empty';
	emptyIndicator.textContent = '无匹配结果';
	emptyIndicator.hidden = true;
	overlay.appendChild(emptyIndicator);
	tableSection.appendChild(overlay);
	const entries = [];
	(context.fieldConfig.options ?? []).forEach((option) => {
		const item = document.createElement('div');
		item.className = 'kv-quickpick-item';
		item.dataset.value = option.value;
		const textWrapper = document.createElement('div');
		textWrapper.className = 'kv-quickpick-text';
		const hasCustomLabel = option.label && option.label !== option.value;
		const primaryText = option.description || (hasCustomLabel ? option.label : option.value);
		const showDetail = primaryText !== option.value;
		const labelEl = document.createElement('div');
		labelEl.className = 'kv-quickpick-label';
		labelEl.textContent = primaryText;
		textWrapper.appendChild(labelEl);
		if (showDetail) {
			const detailEl = document.createElement('div');
			detailEl.className = 'kv-quickpick-detail';
			detailEl.textContent = option.value;
			textWrapper.appendChild(detailEl);
		}
		item.appendChild(textWrapper);
		const checkEl = document.createElement('div');
		checkEl.className = 'kv-quickpick-check';
		checkEl.textContent = '✔';
		item.appendChild(checkEl);
		item.addEventListener('mousedown', (event) => {
			event.preventDefault();
		});
		item.addEventListener('click', (event) => {
			event.preventDefault();
			toggleMultiSelectOption(option.value);
		});
		const entry = {
			option,
			element: item,
			matches: true,
			searchText: `${option.value} ${option.label || ''} ${option.description || ''}`.toLowerCase(),
		};
		entries.push(entry);
		list.appendChild(item);
	});
	const reposition = () => {
		const tableRect = tableSection.getBoundingClientRect();
		const cellRect = context.td.getBoundingClientRect();
		const top = cellRect.bottom - tableRect.top + tableSection.scrollTop;
		const left = cellRect.left - tableRect.left + tableSection.scrollLeft;
		overlay.style.top = `${top}px`;
		overlay.style.left = `${left}px`;
		const minWidth = Math.max(cellRect.width, 220);
		overlay.style.minWidth = `${minWidth}px`;
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
	const state = {
		overlay,
		select: context.select,
		display: context.display,
		fieldConfig: context.fieldConfig,
		td: context.td,
		isMulti: isMultiSelect,
		reposition,
		outsideHandler,
		keyHandler,
		scrollHandler,
		resizeHandler,
		searchInput,
		searchHandlers: {},
		entries,
		visibleEntries: [],
		activeIndex: -1,
		emptyIndicator,
		focusSearch: () => {
			if (document.activeElement !== searchInput) {
				searchInput.focus({ preventScroll: true });
			}
		},
		setActiveIndex: (index) => { },
		moveActive: (delta) => { },
		getActiveEntry: () => undefined,
		setActiveEntry: () => { },
		applyFilter: () => { },
	};
	state.setActiveIndex = (index) => {
		(state.entries || []).forEach((entry) => {
			if (entry?.element) {
				entry.element.classList.remove('kv-quickpick-item-active');
			}
		});
		const visible = state.visibleEntries || [];
		if (!visible.length || index === undefined || index === null || index < 0) {
			state.activeIndex = -1;
			return;
		}
		const normalized = (index % visible.length + visible.length) % visible.length;
		state.activeIndex = normalized;
		const activeEntry = visible[normalized];
		if (activeEntry && activeEntry.element) {
			activeEntry.element.classList.add('kv-quickpick-item-active');
			activeEntry.element.scrollIntoView({ block: 'nearest' });
		}
	};
	state.setActiveEntry = (target) => {
		const visible = state.visibleEntries || [];
		const idx = visible.indexOf(target);
		if (idx >= 0) {
			state.setActiveIndex(idx);
		}
	};
	state.moveActive = (delta) => {
		const visible = state.visibleEntries || [];
		if (!visible.length) {
			state.setActiveIndex(-1);
			return;
		}
		const nextIndex = state.activeIndex === -1 ? 0 : state.activeIndex + delta;
		state.setActiveIndex(nextIndex);
	};
	state.getActiveEntry = () => {
		const visible = state.visibleEntries || [];
		if (state.activeIndex < 0 || state.activeIndex >= visible.length) {
			return undefined;
		}
		return visible[state.activeIndex];
	};
	state.applyFilter = (term) => {
		const keyword = (term || '').trim().toLowerCase();
		state.visibleEntries = [];
		(state.entries || []).forEach((entry) => {
			if (!entry || !entry.element) {
				return;
			}
			const matches = !keyword || entry.searchText.includes(keyword);
			entry.matches = matches;
			if (matches) {
				entry.element.hidden = false;
				state.visibleEntries.push(entry);
			} else {
				entry.element.hidden = true;
			}
		});
		state.emptyIndicator.hidden = state.visibleEntries.length > 0;
		if (!state.visibleEntries.length) {
			state.setActiveIndex(-1);
			return;
		}
		const active = state.getActiveEntry();
		if (active && state.visibleEntries.includes(active)) {
			state.setActiveEntry(active);
		} else {
			state.setActiveIndex(0);
		}
	};
	const entryLookup = new Map(entries.map((entry) => [entry.option.value, entry]));
	entries.forEach((entry) => {
		entry.element.addEventListener('mouseenter', () => {
			state.setActiveEntry(entry);
		});
	});
	const onSearchInput = () => {
		state.applyFilter(searchInput.value ?? '');
	};
	const onSearchKeyDown = (event) => {
		if (event.key === 'ArrowDown') {
			event.preventDefault();
			state.moveActive(1);
		} else if (event.key === 'ArrowUp') {
			event.preventDefault();
			state.moveActive(-1);
		} else if (event.key === 'Enter') {
			event.preventDefault();
			const activeEntry = state.getActiveEntry();
			if (activeEntry) {
				toggleMultiSelectOption(activeEntry.option.value);
			}
		}
	};
	searchInput.addEventListener('input', onSearchInput);
	searchInput.addEventListener('keydown', onSearchKeyDown);
	state.searchHandlers = { input: onSearchInput, keydown: onSearchKeyDown };
	document.addEventListener('mousedown', outsideHandler, true);
	document.addEventListener('keydown', keyHandler);
	tableSection.addEventListener('scroll', scrollHandler);
	window.addEventListener('resize', resizeHandler);
	reposition();
	openMultiSelectContext = state;
	updateMultiSelectOverlaySelection();
	state.applyFilter('');
	const currentRawValue = readElementValue(context.select, context.fieldConfig);
	const currentValues = isMultiSelect ? splitMultiValue(currentRawValue, context.fieldConfig) : (currentRawValue ? [currentRawValue] : []);
	if (currentValues.length) {
		for (const val of currentValues) {
			const found = entryLookup.get(val);
			if (found) {
				state.setActiveEntry(found);
				break;
			}
		}
	} else {
		state.setActiveIndex(0);
	}
	state.focusSearch();
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
	if (!preservePending && openMultiSelectContext && openMultiSelectContext.isMulti) {
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
	const texturePreviewMap = latestPayload?.texturePreviews ?? Object.create(null);
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
							openMultiSelectDropdown({ td, select, display, fieldConfig, columnName });
						});
					} else {
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
							openMultiSelectDropdown({ td, select, display, fieldConfig, columnName });
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
					const previewInfo = column === 'AbilityTextureName' && row.id ? texturePreviewMap[row.id] : undefined;
					let hostElement = input;
					if (previewInfo && previewInfo.uri) {
						const wrapper = document.createElement('div');
						wrapper.className = 'kv-cell-inline';
						input.classList.add('kv-cell-inline-input');
						wrapper.appendChild(input);
						const preview = document.createElement('div');
						preview.className = 'kv-cell-preview';
						preview.dataset.type = previewInfo.kind === 'item' ? 'item' : 'spell';
						preview.dataset.source = previewInfo.source || '';
						const img = document.createElement('img');
						img.src = previewInfo.uri;
						img.alt = `${row.id ?? ''} icon`;
						img.draggable = false;
						if (previewInfo.fileName) {
							const tooltipParts = [previewInfo.fileName];
							if (previewInfo.source) {
								tooltipParts.push(previewInfo.source === 'addon' ? '项目资源' : '插件资源');
							}
							img.title = tooltipParts.join(' · ');
						}
						preview.appendChild(img);
						wrapper.appendChild(preview);
						hostElement = wrapper;
					}
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
					td.appendChild(hostElement);
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
			const columnName = columnLabels.get(column) ?? column;
			openMultiSelectDropdown({ td, select, display, fieldConfig, columnName });
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
		metaParts.push(`路径类型: ${formatFolderType(payload.folderType)}`);
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

function formatFolderType(folderType) {
	if (!folderType) {
		return '未知';
	}
	return FOLDER_TYPE_LABELS[folderType] || folderType;
}

window.addEventListener('message', event => {
	const message = event.data;
	if (message?.type === 'update') {
		render(message.payload);
	}
});

vscode.postMessage({ type: 'ready' });