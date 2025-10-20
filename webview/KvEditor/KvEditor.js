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
let textureMenuState = null;
const pendingTextureMenuRequests = new Map();

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
	const scriptSupport = latestPayload?.scriptSupport || { applicable: false, baseReady: false, useTypescript: false };
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
					const isScriptColumn = column === 'ScriptFile';
					const enableScriptAction = isScriptColumn && Boolean(scriptSupport?.applicable);
					let inlineWrapper = null;
					let hostElement = input;
					const ensureInlineWrapper = () => {
						if (!inlineWrapper) {
							inlineWrapper = document.createElement('div');
							inlineWrapper.className = 'kv-cell-inline';
							input.classList.add('kv-cell-inline-input');
							inlineWrapper.appendChild(input);
							hostElement = inlineWrapper;
						}
						return inlineWrapper;
					};
					if (previewInfo && previewInfo.uri) {
						const wrapper = ensureInlineWrapper();
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
						preview.classList.add('kv-cell-preview-button');
						preview.tabIndex = 0;
						const openMenu = (event) => {
							event.preventDefault();
							event.stopPropagation();
							openTextureMenu({
								input,
								folderType: latestPayload?.folderType ?? 'custom',
								currentValue: input.value ?? '',
								preferredKind: previewInfo.kind,
								rowId: row.id ?? '',
								column,
							});
						};
						preview.addEventListener('click', openMenu);
						preview.addEventListener('keydown', (event) => {
							if (event.key === 'Enter' || event.key === ' ') {
								openMenu(event);
							}
						});
						wrapper.appendChild(preview);
					}
					let scriptButton = null;
					let updateScriptButtonState;
					if (enableScriptAction) {
						const wrapper = ensureInlineWrapper();
						const button = document.createElement('button');
						button.type = 'button';
						button.className = 'kv-cell-action kv-cell-action-script';
						const icon = document.createElement('span');
						icon.className = 'codicon codicon-go-to-file';
						button.appendChild(icon);
						const extensionLabel = scriptSupport.useTypescript ? '.ts' : '.lua';
						button.addEventListener('click', (event) => {
							event.preventDefault();
							event.stopPropagation();
							requestOpenScriptFile(input.value ?? '');
						});
						button.addEventListener('keydown', (event) => {
							if (event.key === 'Enter' || event.key === ' ') {
								event.preventDefault();
								event.stopPropagation();
								requestOpenScriptFile(input.value ?? '');
							}
						});
						wrapper.appendChild(button);
						scriptButton = button;
						updateScriptButtonState = () => {
							if (!scriptButton) {
								return;
							}
							const hasValue = Boolean((input.value || '').trim());
							if (!scriptSupport.baseReady) {
								scriptButton.disabled = true;
								scriptButton.title = '未配置脚本目录';
							} else if (!hasValue) {
								scriptButton.disabled = true;
								scriptButton.title = '请输入脚本路径';
							} else {
								scriptButton.disabled = false;
								scriptButton.title = `打开脚本文件 (${extensionLabel})`;
							}
						};
						updateScriptButtonState();
						input.addEventListener('input', updateScriptButtonState);
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
						if (updateScriptButtonState) {
							updateScriptButtonState();
						}
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

function createTextureMenuRequestId() {
	return `texture-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function requestTextureMenuData(folderType, requestId) {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			pendingTextureMenuRequests.delete(requestId);
			reject('加载超时');
		}, 15000);
		pendingTextureMenuRequests.set(requestId, { resolve, reject, timeout });
		vscode.postMessage({
			type: 'requestTextureMenu',
			payload: {
				requestId,
				folderType,
			},
		});
	});
}

function requestOpenScriptFile(scriptPath) {
	const value = (scriptPath || '').trim();
	if (!value) {
		return;
	}
	vscode.postMessage({
		type: 'openScriptFile',
		payload: {
			scriptPath: value,
			folderType: latestPayload?.folderType ?? 'custom',
		},
	});
}

function handleTextureMenuData(payload) {
	if (!payload || typeof payload.requestId !== 'string') {
		return;
	}
	const pending = pendingTextureMenuRequests.get(payload.requestId);
	if (!pending) {
		return;
	}
	clearTimeout(pending.timeout);
	pendingTextureMenuRequests.delete(payload.requestId);
	pending.resolve(payload);
}

function handleTextureMenuError(payload) {
	if (!payload || typeof payload.requestId !== 'string') {
		return;
	}
	const pending = pendingTextureMenuRequests.get(payload.requestId);
	if (!pending) {
		return;
	}
	clearTimeout(pending.timeout);
	pendingTextureMenuRequests.delete(payload.requestId);
	pending.reject(payload.error || '加载失败');
}

function openTextureMenu(context) {
	closeTextureMenu();
	closeMultiSelectDropdown({ preservePending: true });
	const requestId = createTextureMenuRequestId();
	const overlayElements = createTextureMenuOverlaySkeleton();
	const keyHandler = (event) => {
		if (event.key === 'Escape') {
			event.preventDefault();
			event.stopPropagation();
			closeTextureMenu();
		}
	};
	document.addEventListener('keydown', keyHandler);
	document.body.classList.add('kv-texture-menu-open');
	textureMenuState = {
		requestId,
		overlay: overlayElements.overlay,
		container: overlayElements.container,
		header: overlayElements.header,
		body: overlayElements.body,
		loading: overlayElements.loading,
		context,
		keyHandler,
		selectedKind: null,
		searchValue: '',
		data: null,
		sourceButtons: new Map(),
		heroWrapper: null,
		heroFilters: [],
		activeHeroId: null,
		searchInput: null,
		displayMode: 'both',
		heroFilterBtn: null,
		heroFilterImg: null,
		heroDropdown: null,
		displayModeButton: null,
		outsideClickHandler: null,
		heroButtonRefs: new Map(),
	};
	requestTextureMenuData(context.folderType, requestId)
		.then((data) => {
			if (!textureMenuState || textureMenuState.requestId !== requestId) {
				return;
			}
			populateTextureMenu(data);
		})
		.catch((error) => {
			if (!textureMenuState || textureMenuState.requestId !== requestId) {
				return;
			}
			showTextureMenuError(typeof error === 'string' ? error : '加载失败');
		});
}

function closeTextureMenu() {
	if (!textureMenuState) {
		return;
	}
	if (textureMenuState.overlay && textureMenuState.overlay.parentElement) {
		textureMenuState.overlay.parentElement.removeChild(textureMenuState.overlay);
	}
	if (textureMenuState.keyHandler) {
		document.removeEventListener('keydown', textureMenuState.keyHandler);
	}
	if (textureMenuState.outsideClickHandler) {
		document.removeEventListener('mousedown', textureMenuState.outsideClickHandler);
	}
	const pending = pendingTextureMenuRequests.get(textureMenuState.requestId);
	if (pending) {
		clearTimeout(pending.timeout);
		pendingTextureMenuRequests.delete(textureMenuState.requestId);
	}
	document.body.classList.remove('kv-texture-menu-open');
	textureMenuState = null;
}

function createTextureMenuOverlaySkeleton() {
	const overlay = document.createElement('div');
	overlay.className = 'kv-texture-menu-overlay';
	const container = document.createElement('div');
	container.className = 'kv-texture-menu';
	const header = document.createElement('div');
	header.className = 'kv-texture-menu-header';
	const body = document.createElement('div');
	body.className = 'kv-texture-menu-body';
	const loading = document.createElement('div');
	loading.className = 'kv-texture-menu-loading';
	loading.textContent = '加载图标中…';
	body.appendChild(loading);
	container.appendChild(header);
	container.appendChild(body);
	container.addEventListener('click', (event) => event.stopPropagation());
	overlay.addEventListener('click', () => closeTextureMenu());
	overlay.appendChild(container);
	document.body.appendChild(overlay);
	return { overlay, container, header, body, loading };
}

function populateTextureMenu(data) {
	if (!textureMenuState) {
		return;
	}
	textureMenuState.data = data;
	textureMenuState.heroFilters = data.heroFilters || [];
	textureMenuState.header.innerHTML = '';
	textureMenuState.body.innerHTML = '';
	const hasSpellIcons = data.icons.some((icon) => icon.kind === 'spell');
	const hasItemIcons = data.icons.some((icon) => icon.kind === 'item');
	let selectedKind = data.defaultKind;
	if (textureMenuState.context.preferredKind && data.icons.some((icon) => icon.kind === textureMenuState.context.preferredKind)) {
		selectedKind = textureMenuState.context.preferredKind;
	}
	if (!data.icons.some((icon) => icon.kind === selectedKind)) {
		selectedKind = hasSpellIcons ? 'spell' : hasItemIcons ? 'item' : data.defaultKind;
	}
	textureMenuState.selectedKind = selectedKind;
	textureMenuState.searchValue = textureMenuState.context.currentValue || '';
	const headerRow = document.createElement('div');
	headerRow.className = 'kv-texture-menu-search-row';
	const toggleGroup = document.createElement('div');
	toggleGroup.className = 'kv-texture-menu-toggle-group';
	const spellButton = createTextureMenuToggleButton('spell', '技能图标', hasSpellIcons);
	const itemButton = createTextureMenuToggleButton('item', '物品图标', hasItemIcons);
	textureMenuState.sourceButtons.set('spell', spellButton);
	textureMenuState.sourceButtons.set('item', itemButton);
	toggleGroup.appendChild(spellButton);
	toggleGroup.appendChild(itemButton);
	headerRow.appendChild(toggleGroup);
	const searchWrapper = document.createElement('div');
	searchWrapper.className = 'kv-texture-menu-search';
	const searchInput = document.createElement('input');
	searchInput.type = 'search';
	searchInput.placeholder = '输入关键字（空格分隔）';
	searchInput.value = textureMenuState.searchValue;
	searchInput.addEventListener('input', () => handleTextureMenuSearchChange(searchInput.value));
	searchWrapper.appendChild(searchInput);
	headerRow.appendChild(searchWrapper);
	textureMenuState.searchInput = searchInput;
	// filter area will contain hero-filter button and display-mode toggle
	const filterWrapper = document.createElement('div');
	filterWrapper.className = 'kv-texture-menu-filter';
	// hero filter button (shows current hero or icon)
	const heroFilterBtn = document.createElement('button');
	heroFilterBtn.type = 'button';
	heroFilterBtn.className = 'kv-texture-menu-hero-filter-btn';
	heroFilterBtn.title = '英雄筛选';
	// small img inside
	const heroFilterImg = document.createElement('img');
	heroFilterImg.className = 'kv-texture-menu-hero-filter-img';
	heroFilterImg.alt = '英雄';
	heroFilterBtn.appendChild(heroFilterImg);
	filterWrapper.appendChild(heroFilterBtn);

	// display mode toggle (icon only vs icon+label)
	const displayModeBtn = document.createElement('button');
	displayModeBtn.type = 'button';
	displayModeBtn.className = 'kv-texture-menu-displaymode-btn';
	displayModeBtn.title = '切换显示模式';
	filterWrapper.appendChild(displayModeBtn);

	// dropdown panel container (hidden by default)
	const heroDropdown = document.createElement('div');
	heroDropdown.className = 'kv-texture-menu-hero-dropdown';
	heroDropdown.hidden = true;
	filterWrapper.appendChild(heroDropdown);

	headerRow.appendChild(filterWrapper);
	textureMenuState.heroWrapper = heroDropdown;
	textureMenuState.displayMode = textureMenuState.displayMode || 'both';
	textureMenuState.heroFilterBtn = heroFilterBtn;
	textureMenuState.heroFilterImg = heroFilterImg;
	textureMenuState.heroDropdown = heroDropdown;
	textureMenuState.displayModeButton = displayModeBtn;

	const outsideClickHandler = (event) => {
		if (!textureMenuState || !textureMenuState.heroDropdown || !textureMenuState.heroFilterBtn) {
			return;
		}
		if (!filterWrapper.contains(event.target)) {
			textureMenuState.heroDropdown.hidden = true;
		}
	};
	document.addEventListener('mousedown', outsideClickHandler);
	textureMenuState.outsideClickHandler = outsideClickHandler;

	// interactions
	heroFilterBtn.addEventListener('click', (e) => {
		e.stopPropagation();
		if (heroFilterBtn.disabled) {
			return;
		}
		if (textureMenuState && textureMenuState.selectedKind !== 'spell') {
			// only enabled for abilities
			return;
		}
		if (heroDropdown.hidden) {
			heroDropdown.hidden = false;
		} else {
			heroDropdown.hidden = true;
		}
	});
	displayModeBtn.addEventListener('click', () => {
		if (!textureMenuState) return;
		textureMenuState.displayMode = textureMenuState.displayMode === 'icon' ? 'both' : 'icon';
		updateDisplayModeButton();
		renderTextureMenuGrid();
	});
	updateDisplayModeButton();
	textureMenuState.header.appendChild(headerRow);
	buildHeroFilterButtons();
	updateTextureMenuToggleState();
	renderTextureMenuGrid();
	if (textureMenuState.searchInput) {
		textureMenuState.searchInput.focus();
		if (textureMenuState.searchInput.value) {
			textureMenuState.searchInput.select();
		}
	}
}

function createTextureMenuToggleButton(kind, label, available) {
	const button = document.createElement('button');
	button.type = 'button';
	button.className = 'kv-texture-menu-toggle';
	button.textContent = label;
	button.dataset.kind = kind;
	if (!available) {
		button.disabled = true;
		button.classList.add('kv-texture-menu-toggle-disabled');
	}
	button.addEventListener('click', () => {
		if (button.disabled) {
			return;
		}
		setTextureMenuKind(kind);
	});
	return button;
}

function setTextureMenuKind(kind) {
	if (!textureMenuState || textureMenuState.selectedKind === kind) {
		return;
	}
	textureMenuState.selectedKind = kind;
	if (kind !== 'spell') {
		textureMenuState.activeHeroId = null;
	}
	updateTextureMenuToggleState();
	applyTextureMenuHeroVisibility();
	renderTextureMenuGrid();
}

function updateTextureMenuToggleState() {
	if (!textureMenuState) {
		return;
	}
	for (const [kind, button] of textureMenuState.sourceButtons.entries()) {
		if (kind === textureMenuState.selectedKind) {
			button.classList.add('kv-texture-menu-toggle-active');
		} else {
			button.classList.remove('kv-texture-menu-toggle-active');
		}
	}
	applyTextureMenuHeroVisibility();
}

function buildHeroFilterButtons(heroFilters) {
	if (!textureMenuState || !textureMenuState.heroWrapper) {
		return;
	}
	const dropdown = textureMenuState.heroWrapper;
	dropdown.innerHTML = '';
	textureMenuState.heroButtonRefs = new Map();
	const effectiveHeroes = heroFilters || textureMenuState.heroFilters;
	if (!effectiveHeroes || !effectiveHeroes.length) {
		dropdown.hidden = true;
		return;
	}
	const groups = {
		DOTA_ATTRIBUTE_STRENGTH: [],
		DOTA_ATTRIBUTE_AGILITY: [],
		DOTA_ATTRIBUTE_INTELLECT: [],
		DOTA_ATTRIBUTE_ALL: [],
		OTHER: [],
	};
	for (const hero of effectiveHeroes) {
		const attr = hero.attribute || 'OTHER';
		if (attr && groups[attr]) {
			groups[attr].push(hero);
		} else if (attr && attr.startsWith('DOTA_ATTRIBUTE_')) {
			groups.OTHER.push(hero);
		} else {
			groups.OTHER.push(hero);
		}
	}
	const clearBtn = document.createElement('button');
	clearBtn.type = 'button';
	clearBtn.className = 'kv-texture-menu-hero-clear';
	clearBtn.textContent = '全部';
	clearBtn.addEventListener('click', (e) => {
		e.stopPropagation();
		selectHeroFilter();
		dropdown.hidden = true;
	});
	dropdown.appendChild(clearBtn);
	textureMenuState.heroButtonRefs.set('__all__', clearBtn);

	const makeSection = (title, list) => {
		if (!list.length) return;
		const sec = document.createElement('div');
		sec.className = 'kv-texture-menu-hero-section';
		const h = document.createElement('div');
		h.className = 'kv-texture-menu-hero-section-title';
		h.textContent = title;
		sec.appendChild(h);
		const wrap = document.createElement('div');
		wrap.className = 'kv-texture-menu-hero-grid';
		for (const hero of list) {
			const btn = document.createElement('button');
			btn.type = 'button';
			btn.className = 'kv-texture-menu-hero-select';
			btn.title = hero.name;
			const img = document.createElement('img');
			img.src = hero.uri;
			img.alt = hero.name;
			btn.appendChild(img);
			btn.addEventListener('click', (e) => {
				e.stopPropagation();
				selectHeroFilter(hero);
				dropdown.hidden = true;
			});
			wrap.appendChild(btn);
			textureMenuState.heroButtonRefs.set(hero.id, btn);
		}
		sec.appendChild(wrap);
		dropdown.appendChild(sec);
	};
	makeSection('力量', groups.DOTA_ATTRIBUTE_STRENGTH);
	makeSection('敏捷', groups.DOTA_ATTRIBUTE_AGILITY);
	makeSection('智力', groups.DOTA_ATTRIBUTE_INTELLECT);
	makeSection('全才', groups.DOTA_ATTRIBUTE_ALL);
	makeSection('其他', groups.OTHER);
	dropdown.hidden = textureMenuState.selectedKind !== 'spell';
	updateHeroFilterButtonImage();
	updateHeroFilterSelection();
}

function applyTextureMenuHeroVisibility() {
	if (!textureMenuState || !textureMenuState.heroWrapper) {
		return;
	}
	const hasHeroes = Boolean(textureMenuState.heroFilters && textureMenuState.heroFilters.length);
	const shouldEnable = textureMenuState.selectedKind === 'spell' && hasHeroes;
	textureMenuState.heroWrapper.hidden = !shouldEnable;
	if (textureMenuState.heroFilterBtn) {
		textureMenuState.heroFilterBtn.disabled = !shouldEnable;
		textureMenuState.heroFilterBtn.classList.toggle('kv-texture-menu-hero-filter-disabled', !shouldEnable);
	}
	if (textureMenuState.heroDropdown) {
		textureMenuState.heroDropdown.hidden = true;
	}
	if (!shouldEnable) {
		textureMenuState.activeHeroId = null;
		updateHeroFilterSelection();
		updateHeroFilterButtonImage();
	}
}

function selectHeroFilter(hero) {
	if (!textureMenuState) {
		return;
	}
	textureMenuState.activeHeroId = hero ? hero.id : null;
	const value = hero ? hero.searchTerm : '';
	textureMenuState.searchValue = value;
	if (textureMenuState.searchInput) {
		textureMenuState.searchInput.value = value;
		textureMenuState.searchInput.focus();
		if (value) {
			textureMenuState.searchInput.select();
		}
	}
	updateHeroFilterSelection();
	updateHeroFilterButtonImage();
	renderTextureMenuGrid();
}

function updateHeroFilterSelection() {
	if (!textureMenuState) {
		return;
	}
	if (!textureMenuState.heroButtonRefs) {
		return;
	}
	for (const [id, button] of textureMenuState.heroButtonRefs.entries()) {
		if (!(button instanceof HTMLButtonElement)) {
			continue;
		}
		if (id === '__all__') {
			if (!textureMenuState.activeHeroId) {
				button.classList.add('kv-texture-menu-hero-clear-active');
			} else {
				button.classList.remove('kv-texture-menu-hero-clear-active');
			}
			continue;
		}
		if (id === textureMenuState.activeHeroId) {
			button.classList.add('kv-texture-menu-hero-select-active');
		} else {
			button.classList.remove('kv-texture-menu-hero-select-active');
		}
	}
}

function findHeroFilterById(id) {
	if (!textureMenuState || !id) {
		return undefined;
	}
	return (textureMenuState.heroFilters || []).find((hero) => hero.id === id);
}

function getDefaultHeroForButton() {
	if (!textureMenuState) {
		return undefined;
	}
	const heroes = textureMenuState.heroFilters || [];
	if (!heroes.length) {
		return undefined;
	}
	const defaultHero = heroes.find((hero) => /npc_dota_hero_default/i.test(hero.id));
	return defaultHero || heroes[0];
}

function updateHeroFilterButtonImage() {
	if (!textureMenuState || !textureMenuState.heroFilterImg) {
		return;
	}
	let hero = textureMenuState.activeHeroId ? findHeroFilterById(textureMenuState.activeHeroId) : undefined;
	if (!hero) {
		hero = getDefaultHeroForButton();
	}
	if (hero) {
		textureMenuState.heroFilterImg.src = hero.uri;
		textureMenuState.heroFilterImg.alt = hero.name;
		if (textureMenuState.heroFilterBtn) {
			textureMenuState.heroFilterBtn.title = textureMenuState.activeHeroId ? `当前筛选: ${hero.name}` : '英雄筛选';
		}
	} else {
		textureMenuState.heroFilterImg.removeAttribute('src');
		textureMenuState.heroFilterImg.alt = '';
		if (textureMenuState.heroFilterBtn) {
			textureMenuState.heroFilterBtn.title = '英雄筛选';
		}
	}
}

function updateDisplayModeButton() {
	if (!textureMenuState || !textureMenuState.displayModeButton) {
		return;
	}
	const button = textureMenuState.displayModeButton;
	button.innerHTML = '';
	const icon = document.createElement('span');
	const iconOnly = textureMenuState.displayMode === 'icon';
	icon.className = `codicon ${iconOnly ? 'codicon-symbol-color' : 'codicon-symbol-text'}`;
	button.appendChild(icon);
	button.setAttribute('aria-label', iconOnly ? '切换为图文模式' : '切换为纯图模式');
	button.title = iconOnly ? '切换为图文模式' : '切换为纯图模式';
	button.classList.toggle('kv-texture-menu-displaymode-icononly', iconOnly);
}

function handleTextureMenuSearchChange(value) {
	if (!textureMenuState) {
		return;
	}
	textureMenuState.searchValue = value;
	if (!value) {
		textureMenuState.activeHeroId = null;
	} else if (textureMenuState.activeHeroId) {
		const hero = (textureMenuState.heroFilters || []).find((item) => item.id === textureMenuState.activeHeroId);
		if (!hero || hero.searchTerm !== value) {
			textureMenuState.activeHeroId = null;
		}
	}
	updateHeroFilterSelection();
	updateHeroFilterButtonImage();
	renderTextureMenuGrid();
}

function filterTextureMenuIcons() {
	if (!textureMenuState || !textureMenuState.data) {
		return [];
	}
	const icons = textureMenuState.data.icons.filter((icon) => icon.kind === textureMenuState.selectedKind);
	const rawSearch = (textureMenuState.searchValue || '').toLowerCase();
	const keywords = rawSearch
		.trim()
		.split(/\s+/)
		.filter(Boolean);
	if (!keywords.length) {
		return icons;
	}
	return icons.filter((icon) => keywords.every((keyword) => matchesTextureMenuKeyword(icon, keyword)));
}

function matchesTextureMenuKeyword(icon, keyword) {
	if (!keyword) {
		return true;
	}
	const searchKey = (icon.searchKey || '').toLowerCase();
	const relativePathLower = getIconRelativePathLower(icon);
	if (relativePathLower.includes(keyword)) {
		return true;
	}
	const textureNameLower = getIconTextureNameLower(icon);
	if (textureNameLower.includes(keyword)) {
		return true;
	}
	const variants = new Set();
	variants.add(keyword);
	const underscoreNormalized = keyword.includes('_') ? keyword.replace(/_/g, ' ') : keyword;
	variants.add(underscoreNormalized);
	const fullyNormalized = underscoreNormalized.replace(/[\\/]+/g, ' ');
	variants.add(fullyNormalized);
	const slashOnlyNormalized = keyword.replace(/[\\/]+/g, ' ');
	variants.add(slashOnlyNormalized);
	for (const variant of variants) {
		const normalized = variant.trim();
		if (!normalized) {
			continue;
		}
		if (searchKey.includes(normalized)) {
			return true;
		}
		if (textureNameLower.includes(normalized)) {
			return true;
		}
	}
	return false;
}

function getIconRelativePathLower(icon) {
	if (!icon) {
		return '';
	}
	if (!icon._relativePathLower) {
		icon._relativePathLower = (icon.relativePath || '').toLowerCase();
	}
	return icon._relativePathLower;
}

function getIconTextureNameLower(icon) {
	if (!icon) {
		return '';
	}
	if (!icon._textureNameLower) {
		icon._textureNameLower = (icon.textureName || '').toLowerCase();
	}
	return icon._textureNameLower;
}

function renderTextureMenuGrid() {
	if (!textureMenuState) {
		return;
	}
	const body = textureMenuState.body;
	body.innerHTML = '';
	const filteredIcons = filterTextureMenuIcons();
	if (!filteredIcons.length) {
		const empty = document.createElement('div');
		empty.className = 'kv-texture-menu-empty';
		empty.textContent = '未找到匹配的图标。';
		body.appendChild(empty);
		return;
	}
	const groups = [
		{ source: 'extension', title: '插件图标' },
		{ source: 'addon', title: '项目图标' },
	];
	const currentValue = (textureMenuState.context.input.value || '').toLowerCase();
	const showLabel = textureMenuState.displayMode !== 'icon';
	for (const group of groups) {
		const icons = filteredIcons.filter((icon) => icon.source === group.source);
		if (!icons.length) {
			continue;
		}
		const section = document.createElement('div');
		section.className = 'kv-texture-menu-section';
		const title = document.createElement('div');
		title.className = 'kv-texture-menu-section-title';
		title.textContent = group.title;
		section.appendChild(title);
		const grid = document.createElement('div');
		grid.className = 'kv-texture-menu-grid kv-texture-menu-grid-tight';
		for (const icon of icons) {
			const button = document.createElement('button');
			button.type = 'button';
			button.className = 'kv-texture-menu-item';
			button.dataset.texture = icon.textureName;
			const img = document.createElement('img');
			img.src = icon.uri;
			img.alt = icon.label || icon.textureName;
			button.appendChild(img);
			if (showLabel) {
				const caption = document.createElement('span');
				caption.className = 'kv-texture-menu-item-label';
				caption.textContent = icon.label || icon.textureName;
				button.appendChild(caption);
			} else {
				button.classList.add('kv-texture-menu-item-icononly');
				button.setAttribute('aria-label', icon.label || icon.textureName);
			}
			button.title = `${icon.textureName}\n${icon.relativePath}`;
			if (icon.textureName.toLowerCase() === currentValue) {
				button.classList.add('kv-texture-menu-item-selected');
			}
			button.addEventListener('click', () => handleTextureSelection(icon));
			grid.appendChild(button);
		}
		section.appendChild(grid);
		body.appendChild(section);
	}
}

function handleTextureSelection(icon) {
	if (!textureMenuState) {
		return;
	}
	const input = textureMenuState.context.input;
	const newValue = icon.textureName;
	const currentValue = readElementValue(input, undefined);
	if (currentValue === newValue) {
		closeTextureMenu();
		return;
	}
	setElementValue(input, newValue, undefined);
	handleElementChange(input, undefined);
	if (selectedCell && selectedCell.element === input && formulaValueInput) {
		formulaValueInput.value = newValue;
	}
	closeTextureMenu();
}

function showTextureMenuError(message) {
	if (!textureMenuState) {
		return;
	}
	textureMenuState.header.innerHTML = '';
	textureMenuState.body.innerHTML = '';
	const errorBox = document.createElement('div');
	errorBox.className = 'kv-texture-menu-error';
	errorBox.textContent = message || '加载失败';
	textureMenuState.body.appendChild(errorBox);
	const closeButton = document.createElement('button');
	closeButton.type = 'button';
	closeButton.className = 'kv-texture-menu-close-button-inline';
	closeButton.textContent = '关闭';
	closeButton.addEventListener('click', () => closeTextureMenu());
	textureMenuState.body.appendChild(closeButton);
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

window.addEventListener('message', (event) => {
	const message = event.data;
	if (!message || typeof message.type !== 'string') {
		return;
	}
	switch (message.type) {
		case 'update':
			render(message.payload);
			break;
		case 'textureMenuData':
			handleTextureMenuData(message.payload);
			break;
		case 'textureMenuError':
			handleTextureMenuError(message.payload);
			break;
		default:
			break;
	}
});

vscode.postMessage({ type: 'ready' });