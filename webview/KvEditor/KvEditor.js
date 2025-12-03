const vscode = acquireVsCodeApi();

const fileNameEl = document.getElementById('kv-file-name');
const fileMetaEl = document.getElementById('kv-file-meta');
const openTextEditorBtn = document.getElementById('kv-open-text-editor');
const toggleCompactModeBtn = document.getElementById('kv-toggle-compact-mode');
const toggleLocalizedModeBtn = document.getElementById('kv-toggle-localized-mode');
const tableSection = document.getElementById('kv-table');
const emptySection = document.getElementById('kv-empty');
const errorSection = document.getElementById('kv-error');
const formulaAddressInput = document.getElementById('kv-editor-address');
const formulaValueInput = document.getElementById('kv-editor-value');
const formulaHelpBtn = document.getElementById('kv-formula-help');

if (emptySection) {
	emptySection.textContent = 'Loading KV data...';
}
setSectionVisibility({ showTable: false, showEmpty: true, showError: false });

// 绑定公式帮助按钮
if (formulaHelpBtn) {
	formulaHelpBtn.addEventListener('click', () => {
		vscode.postMessage({ type: 'openFormulaHelp' });
	});
}

// 绑定"用文本编辑器打开"按钮事件
if (openTextEditorBtn) {
	openTextEditorBtn.addEventListener('click', () => {
		vscode.postMessage({ type: 'openTextEditor' });
	});
}

// 精简模式状态管理
let compactMode = false;

// 本地化模式状态管理
let localizedMode = false;

// 列描述配置
let columnDescriptions = {};

// 冻结列管理
const frozenColumns = new Set();

// 绑定精简模式切换按钮
if (toggleCompactModeBtn) {
	const updateButtonState = () => {
		if (compactMode) {
			toggleCompactModeBtn.classList.add('active');
			toggleCompactModeBtn.title = '精简模式已开启，点击关闭';
		} else {
			toggleCompactModeBtn.classList.remove('active');
			toggleCompactModeBtn.title = '精简模式已关闭，点击开启';
		}
	};
	updateButtonState();

	toggleCompactModeBtn.addEventListener('click', () => {
		compactMode = !compactMode;
		updateButtonState();

		// 保存到后端
		vscode.postMessage({
			type: 'saveCompactMode',
			payload: { compactMode }
		});

		// 立即重新渲染表格
		if (latestPayload) {
			renderTable(latestPayload.columns, latestPayload.rows, columnOptionConfig);
		}
	});
}

// 绑定本地化模式切换按钮
if (toggleLocalizedModeBtn) {
	const updateButtonState = () => {
		if (localizedMode) {
			toggleLocalizedModeBtn.classList.add('active');
			toggleLocalizedModeBtn.title = '本地化模式已开启，显示描述';
		} else {
			toggleLocalizedModeBtn.classList.remove('active');
			toggleLocalizedModeBtn.title = '本地化模式已关闭，显示原文';
		}
	};
	updateButtonState();

	toggleLocalizedModeBtn.addEventListener('click', () => {
		localizedMode = !localizedMode;
		updateButtonState();

		// 保存到后端
		vscode.postMessage({
			type: 'saveLocalizedMode',
			payload: { localizedMode }
		});

		// 立即重新渲染表格
		if (latestPayload) {
			renderTable(latestPayload.columns, latestPayload.rows, columnOptionConfig);
		}
	});
}

const COLUMN_MIN_WIDTH = 100;
const ROW_NUMBER_COLUMN_KEY = '__rowNumber';
const ROW_NUMBER_MIN_WIDTH = 32;

const FOLDER_TYPE_LABELS = {
	ability: '技能',
	item: '物品',
	unit: '单位',
	custom: '自定义'
};

const FORMULA_TOOLTIP_HELP = [
	'公式示例:',
	'1. baseNumber + offset → 生成 1,2,3,4 序列',
	'2. `Row_${rowNumber}` → 输出 Row_1, Row_2 等标签',
	'3. offset % 2 === 0 ? "A" : "B" → 交替填充 A/B',
	'4. direction === 1 ? baseNumber + offset : baseNumber - offset → 向下递增、向上递减'
].join('\n');

let latestPayload = undefined;
let activeCell = undefined;
const columnWidths = Object.create(null);
let currentDocumentKey = undefined;

let selectedCellKey = undefined;
let selectedCell = undefined;
let selectedTd = undefined;
let suppressFormulaCommit = false;
let columnOptionConfig = Object.create(null);

const modifiedColumns = new Set();
const originalColumnWidths = Object.create(null);
const savedColumnWidths = new Set(); // 记录哪些列的宽度是从配置文件加载的
let columnOptionsEditorState = null;
let resizeState = null;
let openMultiSelectContext = null;
let pendingMultiSelectReopen = null;
let textureMenuState = null;
let abilityValuesEditorState = null;
let rowContextMenuState = null;
let columnContextMenuState = null;
const pendingTextureMenuRequests = new Map();
let rowDragState = null;
let clipboardData = null;
let fillHandleElement = null;
let fillHandleState = null;
let fillPreviewCells = [];
let fillPopupState = null;
let columnDragState = null;
let autofillPopupState = null;

// 行选择状态管理
let selectedRows = new Set(); // 存储选中的行索引
let lastSelectedRowIndex = null; // 用于 Shift 多选
let copiedRowsData = null; // 存储复制的行数据

const FORMULA_ERROR_VALUE = '#ERROR!';
const FORMULA_CYCLE_VALUE = '#CYCLE!';

const formulaDefinitions = new Map();
const formulaComputedValues = new Map();

const FILL_DEFAULT_STEP = 1;
const FILL_DEFAULT_RATIO = 2;
const COLUMN_WIDTH_SAVE_DEBOUNCE_MS = 600;

let columnWidthSaveHandle = null;

document.addEventListener('mousemove', handleColumnResize);
document.addEventListener('mouseup', stopColumnResize);
// 行复制粘贴优先于单元格复制粘贴
document.addEventListener('keydown', handleRowClipboardShortcuts);
document.addEventListener('keydown', handleClipboardShortcuts);
document.addEventListener('keydown', handleEscapeClearSelection);
document.addEventListener('keydown', handleCellNavigation);

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

function makeFormulaDefinitionKey(column, rowId, rowIndex) {
	const columnKey = typeof column === 'string' ? column : '';
	const normalizedId = typeof rowId === 'string' && rowId.length ? rowId : undefined;
	if (normalizedId) {
		return `${columnKey}|id:${normalizedId}`;
	}
	if (Number.isFinite(rowIndex)) {
		const normalizedIndex = Math.max(0, Math.floor(Number(rowIndex)));
		return `${columnKey}|index:${normalizedIndex}`;
	}
	return undefined;
}

function setFormulaDefinition(column, rowId, rowIndex, formula) {
	const trimmed = typeof formula === 'string' ? formula.trim() : '';
	const key = makeFormulaDefinitionKey(column, rowId, rowIndex);
	if (!key) {
		return;
	}
	if (!trimmed || !trimmed.startsWith('=')) {
		formulaDefinitions.delete(key);
		return;
	}
	formulaDefinitions.set(key, {
		column,
		rowId: typeof rowId === 'string' && rowId.length ? rowId : undefined,
		rowIndex: Number.isFinite(rowIndex) ? Math.max(0, Math.floor(Number(rowIndex))) : undefined,
		formula: trimmed,
	});
}

function removeFormulaDefinition(column, rowId, rowIndex) {
	const keys = new Set();
	const idKey = makeFormulaDefinitionKey(column, rowId, undefined);
	if (idKey) {
		keys.add(idKey);
	}
	const indexKey = makeFormulaDefinitionKey(column, undefined, rowIndex);
	if (indexKey) {
		keys.add(indexKey);
	}
	keys.forEach((key) => {
		formulaDefinitions.delete(key);
	});
}

function getFormulaDefinition(column, rowId, rowIndex) {
	const idKey = makeFormulaDefinitionKey(column, rowId, undefined);
	if (idKey && formulaDefinitions.has(idKey)) {
		return formulaDefinitions.get(idKey);
	}
	const indexKey = makeFormulaDefinitionKey(column, undefined, rowIndex);
	if (indexKey && formulaDefinitions.has(indexKey)) {
		return formulaDefinitions.get(indexKey);
	}
	return undefined;
}

function applyFormulaDefinitions(entries) {
	formulaDefinitions.clear();
	if (!Array.isArray(entries)) {
		return;
	}
	entries.forEach((entry) => {
		if (!entry || typeof entry.column !== 'string' || typeof entry.formula !== 'string') {
			return;
		}
		setFormulaDefinition(entry.column, entry.rowId, entry.rowIndex, entry.formula);
	});
}

function makeComputedFormulaKey(column, rowIndex) {
	const columnKey = typeof column === 'string' ? column : '';
	const normalizedIndex = Math.max(0, Math.floor(Number(rowIndex ?? 0)));
	return `${columnKey}|${normalizedIndex}`;
}

function getComputedFormulaEntry(column, rowIndex) {
	const key = makeComputedFormulaKey(column, rowIndex);
	return formulaComputedValues.get(key);
}

function setComputedFormulaEntry(column, rowIndex, entry) {
	const key = makeComputedFormulaKey(column, rowIndex);
	formulaComputedValues.set(key, entry);
}

function clearComputedFormulaEntries() {
	formulaComputedValues.clear();
}

function getCellDisplayValue(rowIndex, rowId, column, fallbackValue) {
	const computed = getComputedFormulaEntry(column, rowIndex);
	if (computed && typeof computed.value === 'string') {
		return computed.value;
	}
	if (fallbackValue !== undefined && fallbackValue !== null) {
		return String(fallbackValue);
	}
	return '';
}

function recalculateFormulas(options = {}) {
	if (!latestPayload || !Array.isArray(latestPayload.rows) || !Array.isArray(latestPayload.columns)) {
		clearComputedFormulaEntries();
		updatePayloadFormulasSnapshot();
		return;
	}
	const { emitUpdates = false } = options;
	const rows = latestPayload.rows;
	const columns = latestPayload.columns;
	if (!formulaDefinitions.size) {
		clearComputedFormulaEntries();
		updatePayloadFormulasSnapshot();
		return;
	}
	const letterToColumn = new Map();
	columns.forEach((column, index) => {
		letterToColumn.set(getColumnLetter(index), column);
	});
	const rowIdToIndex = new Map();
	rows.forEach((row, index) => {
		if (row && typeof row.id === 'string' && row.id.length) {
			rowIdToIndex.set(row.id, index);
		}
	});
	const positionDefinitions = new Map();
	formulaDefinitions.forEach((definition) => {
		if (!definition || typeof definition.column !== 'string' || typeof definition.formula !== 'string') {
			return;
		}
		let resolvedIndex;
		if (definition.rowId && rowIdToIndex.has(definition.rowId)) {
			resolvedIndex = rowIdToIndex.get(definition.rowId);
		} else if (Number.isFinite(definition.rowIndex)) {
			const idx = Math.max(0, Math.floor(Number(definition.rowIndex)));
			if (idx >= 0 && idx < rows.length) {
				resolvedIndex = idx;
			}
		}
		if (resolvedIndex === undefined) {
			return;
		}
		definition.rowIndex = resolvedIndex;
		const row = rows[resolvedIndex];
		if (!definition.rowId && row && typeof row.id === 'string' && row.id.length) {
			definition.rowId = row.id;
		}
		const key = makeComputedFormulaKey(definition.column, resolvedIndex);
		positionDefinitions.set(key, {
			column: definition.column,
			rowId: definition.rowId,
			rowIndex: resolvedIndex,
			formula: definition.formula,
		});
	});
	const previousComputed = new Map(formulaComputedValues);
	clearComputedFormulaEntries();
	if (!positionDefinitions.size) {
		return;
	}
	const visiting = new Set();
	const cache = new Map();
	const getRawValue = (columnKey, rowIndex) => {
		const row = rows[rowIndex];
		if (!row) {
			return '';
		}
		// id 列存储在 row.id 中，不在 row.values 中
		if (columnKey === 'id') {
			return row.id ?? '';
		}
		if (!row.values) {
			return '';
		}
		const raw = row.values[columnKey];
		return raw === undefined || raw === null ? '' : String(raw);
	};
	const computePosition = (columnKey, rowIndex) => {
		const key = makeComputedFormulaKey(columnKey, rowIndex);
		if (cache.has(key)) {
			return cache.get(key);
		}
		if (visiting.has(key)) {
			const cycleResult = { value: FORMULA_CYCLE_VALUE, error: 'CYCLE' };
			cache.set(key, cycleResult);
			return cycleResult;
		}
		visiting.add(key);
		let result;
		const definition = positionDefinitions.get(key);
		if (!definition) {
			result = { value: getRawValue(columnKey, rowIndex) };
		} else {
			const evaluation = evaluateFormulaExpression(definition.formula, {
				resolveReference(columnLetter, rowNumber) {
					const column = letterToColumn.get(columnLetter);
					if (!column) {
						return { value: '', error: 'REF' };
					}
					const targetIndex = rowNumber - 1;
					if (targetIndex < 0 || targetIndex >= rows.length) {
						return { value: '', error: 'REF' };
					}
					return computePosition(column, targetIndex);
				},
				getRawValue: getRawValue,
				context: {
					rowIndex,
					rowNumber: rowIndex + 1,
					rowId: rows[rowIndex]?.id ?? '',
					row: rows[rowIndex],
					values: rows[rowIndex]?.values ?? {},
				},
				resolveColumn(columnLetter) {
					return letterToColumn.get(columnLetter);
				},
			});
			if (evaluation.error) {
				result = { value: FORMULA_ERROR_VALUE, error: evaluation.error };
			} else {
				result = { value: evaluation.value };
			}
		}
		cache.set(key, result);
		visiting.delete(key);
		return result;
	};
	const pendingEdits = [];
	positionDefinitions.forEach((definition) => {
		const evaluation = computePosition(definition.column, definition.rowIndex);
		const value = typeof evaluation.value === 'string' ? evaluation.value : String(evaluation.value ?? '');
		setComputedFormulaEntry(definition.column, definition.rowIndex, {
			column: definition.column,
			rowId: definition.rowId,
			rowIndex: definition.rowIndex,
			value,
			error: evaluation.error,
		});
		// 比较公式计算结果与文件中的实际值
		const targetRow = rows[definition.rowIndex];
		const currentValueInFile = targetRow?.values?.[definition.column];
		const normalizedCurrentValue = currentValueInFile === undefined || currentValueInFile === null
			? ''
			: String(currentValueInFile);
		// 只有当计算结果与文件中的值不一致时才需要更新
		if (normalizedCurrentValue !== value) {
			const row = rows[definition.rowIndex];
			if (row && row.id) {
				pendingEdits.push({ id: row.id, key: definition.column, value });
			}
		}
		// 更新内存中的值
		if (targetRow && targetRow.values) {
			targetRow.values[definition.column] = value;
		}
	});
	if (emitUpdates && pendingEdits.length) {
		dispatchBulkEdit(pendingEdits);
	}
	updatePayloadFormulasSnapshot();
}

function getFormulaDefinitionEntries() {
	return Array.from(formulaDefinitions.values())
		.map((definition) => {
			if (!definition || typeof definition.column !== 'string' || typeof definition.formula !== 'string') {
				return undefined;
			}
			const rowIndex = Number.isFinite(definition.rowIndex)
				? Math.max(0, Math.floor(Number(definition.rowIndex)))
				: undefined;
			if (rowIndex === undefined) {
				return undefined;
			}
			return {
				column: definition.column,
				rowId: definition.rowId,
				rowIndex,
				formula: definition.formula,
			};
		})
		.filter((entry) => Boolean(entry));
}

function updatePayloadFormulasSnapshot() {
	if (!latestPayload) {
		return;
	}
	latestPayload.formulas = getFormulaDefinitionEntries();
}

function postSaveFormulaMessage({ column, rowId, rowIndex, formula }) {
	if (!column) {
		return;
	}
	const payload = { column };
	if (typeof rowId === 'string' && rowId.length) {
		payload.rowId = rowId;
	}
	if (Number.isFinite(rowIndex) && rowIndex >= 0) {
		payload.rowIndex = Math.floor(Number(rowIndex));
	}
	if (typeof formula === 'string') {
		payload.formula = formula;
	}
	vscode.postMessage({
		type: 'saveFormula',
		payload,
	});
}

function replaceCellReferencesInExpression(expression, replacer) {
	if (typeof expression !== 'string' || !expression.length) {
		return { text: '', references: [] };
	}
	let result = '';
	const references = [];
	let index = 0;
	let stringDelimiter = null;
	while (index < expression.length) {
		const char = expression[index];
		if (stringDelimiter) {
			result += char;
			if (char === '\\' && index + 1 < expression.length) {
				result += expression[index + 1];
				index += 2;
				continue;
			}
			if (char === stringDelimiter) {
				stringDelimiter = null;
			}
			index += 1;
			continue;
		}
		if (char === '"' || char === '\'' || char === '`') {
			stringDelimiter = char;
			result += char;
			index += 1;
			continue;
		}
		if (/[A-Za-z]/.test(char)) {
			let start = index;
			let letters = '';
			while (index < expression.length && /[A-Za-z]/.test(expression[index])) {
				letters += expression[index];
				index += 1;
			}
			if (/^[A-Z]+$/.test(letters) && index < expression.length && /\d/.test(expression[index])) {
				let digits = '';
				while (index < expression.length && /\d/.test(expression[index])) {
					digits += expression[index];
					index += 1;
				}
				const rowNumber = Number(digits);
				if (Number.isFinite(rowNumber) && rowNumber > 0) {
					const replacement = replacer(letters, rowNumber, `${letters}${digits}`);
					if (replacement !== undefined) {
						result += replacement;
						references.push({ columnLetter: letters, rowNumber });
						continue;
					}
				}
				result += letters + digits;
				continue;
			}
			result += letters;
			continue;
		}
		result += char;
		index += 1;
	}
	return { text: result, references };
}

function evaluateFormulaExpression(formula, hooks = {}) {
	const trimmed = typeof formula === 'string' ? formula.trim() : '';
	if (!trimmed.startsWith('=')) {
		return { value: trimmed };
	}
	const expressionBody = trimmed.slice(1);
	const rewrite = replaceCellReferencesInExpression(expressionBody, (columnLetter, rowNumber) => {
		return `__ref(${JSON.stringify(columnLetter)}, ${Number(rowNumber)})`;
	});
	let evaluator;
	try {
		evaluator = new Function(
			'__ref',
			'__helpers',
			'Math',
			'Number',
			'String',
			`"use strict";\nconst __ctx = __helpers.context || {};\nconst { rowIndex = 0, rowNumber = rowIndex + 1, rowId = "", row = undefined, values = {} } = __ctx;\nconst { toNumber, toString } = __helpers;\nreturn (${rewrite.text});`,
		);
	} catch (error) {
		return { value: '', error: 'PARSE' };
	}
	let referenceError = null;
	const referenceGetter = (columnLetter, rowNumber) => {
		if (typeof hooks.resolveReference !== 'function') {
			referenceError = referenceError ?? 'REF';
			return '';
		}
		try {
			const result = hooks.resolveReference(columnLetter, Number(rowNumber));
			if (!result) {
				referenceError = referenceError ?? 'REF';
				return '';
			}
			if (result.error) {
				referenceError = referenceError ?? result.error;
			}
			return result.value ?? '';
		} catch (error) {
			referenceError = referenceError ?? 'REF';
			return '';
		}
	};
	const helpers = {
		toNumber(value, fallback = 0) {
			if (typeof value === 'number') {
				return Number.isFinite(value) ? value : fallback;
			}
			const parsed = Number(value);
			return Number.isFinite(parsed) ? parsed : fallback;
		},
		toString(value) {
			if (value === undefined || value === null) {
				return '';
			}
			return String(value);
		},
		context: hooks.context || {},
	};
	try {
		const value = evaluator(referenceGetter, helpers, Math, Number, String);
		if (referenceError) {
			return { value, error: referenceError };
		}
		return { value };
	} catch (error) {
		return { value: '', error: 'EXEC' };
	}
}

function applyFormulaDecorations(td, definition, computed) {
	if (!td) {
		return;
	}
	if (definition && typeof definition.formula === 'string' && definition.formula.length) {
		td.dataset.formula = definition.formula;
		td.classList.add('kv-cell-formula');
	} else {
		delete td.dataset.formula;
		td.classList.remove('kv-cell-formula');
	}
	if (computed && computed.error) {
		td.dataset.formulaError = computed.error;
		td.classList.add('kv-cell-formula-error');
	} else {
		delete td.dataset.formulaError;
		td.classList.remove('kv-cell-formula-error');
	}
}

function updateFormulaCell(columnKey, rowIndex) {
	if (!tableSection || !Array.isArray(latestPayload?.rows)) {
		return;
	}
	const selector = `td[data-column="${columnKey}"][data-row-index="${rowIndex}"]`;
	const td = tableSection.querySelector(selector);
	if (!td) {
		return;
	}
	const row = latestPayload.rows[rowIndex];
	const rowId = td.dataset.rowId ?? row?.id ?? '';
	const definition = getFormulaDefinition(columnKey, rowId, rowIndex);
	const computed = getComputedFormulaEntry(columnKey, rowIndex);
	applyFormulaDecorations(td, definition, computed);
	const displayValue = getCellDisplayValue(rowIndex, rowId, columnKey, row?.values?.[columnKey]);
	const fieldConfig = columnOptionConfig?.[columnKey];
	const input = td.querySelector('input');
	const select = td.querySelector('select');
	if (input) {
		setElementValue(input, displayValue, undefined);
		input.dataset.initialValue = input.value ?? '';
		if (definition) {
			input.dataset.formulaValue = definition.formula;
		} else {
			delete input.dataset.formulaValue;
		}
		input.title = input.value;
	} else if (select) {
		setElementValue(select, displayValue, fieldConfig);
		const normalized = readElementValue(select, fieldConfig);
		select.dataset.initialValue = normalized;
		if (definition) {
			select.dataset.formulaValue = definition.formula;
		} else {
			delete select.dataset.formulaValue;
		}
		select.title = normalized;
		const display = td.querySelector('.kv-select-display');
		if (display) {
			updateSelectDisplay(select, display, fieldConfig);
		}
	} else if (!td.classList.contains('kv-ability-values-cell')) {
		td.textContent = displayValue;
	}
	if (td.dataset) {
		td.dataset.displayValue = displayValue;
	}
	if (selectedTd === td) {
		if (selectedCell) {
			selectedCell.value = displayValue;
			selectedCell.formula = definition ? definition.formula : undefined;
			selectedCell.formulaError = computed?.error;
		}
		if (formulaValueInput) {
			if (definition && definition.formula) {
				formulaValueInput.value = definition.formula;
			} else {
				formulaValueInput.value = displayValue ?? '';
			}
		}
	}
}

function refreshFormulaResultsForTable() {
	if (!tableSection || !Array.isArray(latestPayload?.rows)) {
		return;
	}
	const seen = new Set();
	formulaDefinitions.forEach((definition) => {
		if (!definition || typeof definition.column !== 'string' || !Number.isFinite(definition.rowIndex)) {
			return;
		}
		const normalizedIndex = Math.max(0, Math.floor(Number(definition.rowIndex)));
		seen.add(makeComputedFormulaKey(definition.column, normalizedIndex));
		updateFormulaCell(definition.column, normalizedIndex);
	});
	const decorated = tableSection.querySelectorAll('td.kv-cell-formula, td[data-formula]');
	decorated.forEach((td) => {
		const column = td.dataset.column;
		const rowIndex = Number(td.dataset.rowIndex ?? '-1');
		if (!column || !Number.isFinite(rowIndex) || rowIndex < 0) {
			return;
		}
		const key = makeComputedFormulaKey(column, rowIndex);
		if (seen.has(key)) {
			return;
		}
		updateFormulaCell(column, rowIndex);
	});
}

// 清空当前选中单元格及其公式编辑器状态
function clearSelection() {
	closeMultiSelectDropdown();
	closeFillPopup();
	clearFillPreview();
	detachFillHandle();
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
	closeRowContextMenu();
	closeColumnContextMenu();
	if (!td || !context) {
		clearSelection();
		return;
	}
	if (openMultiSelectContext && openMultiSelectContext.td !== td) {
		closeMultiSelectDropdown();
	}
	if (selectedTd && selectedTd !== td) {
		selectedTd.classList.remove('kv-cell-selected');
		closeFillPopup();
		clearFillPreview();
		detachFillHandle();
	}
	selectedTd = td;
	td.classList.add('kv-cell-selected');
	const formulaDefinition = getFormulaDefinition(context.column, context.rowId, context.rowIndex);
	const computedEntry = getComputedFormulaEntry(context.column, context.rowIndex);
	const displayValue = getCellDisplayValue(context.rowIndex, context.rowId, context.column, context.value);
	selectedCell = {
		column: context.column,
		columnLetter: context.columnLetter,
		columnName: context.columnName,
		rowId: context.rowId,
		rowIndex: context.rowIndex,
		editable: context.editable,
		element: context.element ?? null,
		fieldConfig: context.fieldConfig,
		usesDropdown: Boolean(context.usesDropdown),
		value: displayValue,
		dataType: context.dataType ?? 'cell',
		abilityEntries: context.dataType === 'abilityValues' ? cloneAbilityValuesEntries(context.abilityEntries || []) : undefined,
		hasAbilityField: Boolean(context.hasAbilityField),
		formula: formulaDefinition ? formulaDefinition.formula : undefined,
		formulaError: computedEntry?.error,
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
		if (formulaDefinition && formulaDefinition.formula) {
			formulaValueInput.value = formulaDefinition.formula;
		} else {
			formulaValueInput.value = displayValue ?? '';
		}
	}
	refreshFillHandle();
}

function isEditableElement(element) {
	if (!element) {
		return false;
	}
	if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
		return true;
	}
	return Boolean(element.isContentEditable);
}

function copyTextToClipboard(text) {
	const helper = document.createElement('textarea');
	try {
		helper.value = text ?? '';
		helper.setAttribute('readonly', '');
		helper.style.position = 'fixed';
		helper.style.opacity = '0';
		helper.style.pointerEvents = 'none';
		helper.style.top = '0';
		helper.style.left = '0';
		document.body.appendChild(helper);
		helper.focus();
		helper.select();
		document.execCommand('copy');
	} catch (error) {
		console.warn('[kv-editor] copy failed', error);
	} finally {
		if (helper.parentElement) {
			helper.parentElement.removeChild(helper);
		}
	}
}

function copySelectedCell() {
	if (!selectedCell) {
		return;
	}
	let text = '';
	if (selectedCell.dataType === 'abilityValues') {
		const entries = cloneAbilityValuesEntries(selectedCell.abilityEntries || []);
		clipboardData = {
			type: 'abilityValues',
			entries,
			hasAbilityField: Boolean(selectedCell.hasAbilityField),
			text: selectedCell.value ?? ''
		};
		text = clipboardData.text;
	} else if (selectedCell.editable && selectedCell.element) {
		const value = readElementValue(selectedCell.element, selectedCell.fieldConfig);
		clipboardData = {
			type: 'cell',
			value,
			column: selectedCell.column,
			text: value
		};
		text = value;
	} else {
		const value = selectedCell.value ?? '';
		clipboardData = {
			type: 'text',
			value,
			column: selectedCell.column,
			text: value
		};
		text = value;
	}
	copyTextToClipboard(text ?? '');
}

function pasteToSelectedCell() {
	if (!selectedCell || !clipboardData) {
		return;
	}
	if (selectedCell.dataType === 'abilityValues') {
		if (clipboardData.type !== 'abilityValues' || !selectedTd) {
			return;
		}
		if (!selectedCell.rowId) {
			return;
		}
		const hasAbilityField = clipboardData.hasAbilityField !== false || selectedCell.hasAbilityField;
		const { entries: sanitizedEntries, displayValue } = populateAbilityValuesCell(selectedTd, clipboardData.entries || [], hasAbilityField !== false);
		selectedCell.value = displayValue;
		selectedCell.abilityEntries = cloneAbilityValuesEntries(sanitizedEntries);
		selectedCell.hasAbilityField = hasAbilityField !== false;
		if (formulaValueInput) {
			formulaValueInput.value = displayValue;
		}
		const payloadEntries = normalizeAbilityEntriesForPayload(sanitizedEntries);
		vscode.postMessage({
			type: 'editAbilityValues',
			payload: {
				id: selectedCell.rowId,
				entries: payloadEntries,
			}
		});
		if (Array.isArray(latestPayload?.rows) && typeof selectedCell.rowIndex === 'number') {
			const targetRow = latestPayload.rows[selectedCell.rowIndex];
			if (targetRow) {
				targetRow.abilityValues = sanitizedEntries.map((entry) => ({
					key: entry.key,
					originalKey: entry.originalKey,
					value: entry.value,
					type: entry.type,
					modifiers: (entry.modifiers || []).map((modifier) => ({
						key: modifier.key,
						value: modifier.value,
					}))
				}));
				if (!targetRow.values || typeof targetRow.values !== 'object') {
					targetRow.values = {};
				}
				if (selectedCell.hasAbilityField) {
					targetRow.values.AbilityValues = targetRow.values.AbilityValues ?? '';
				} else if (targetRow.values) {
					delete targetRow.values.AbilityValues;
				}
			}
		}
		return;
	}
	if (!selectedCell.editable || !selectedCell.element) {
		return;
	}
	if (clipboardData.type === 'abilityValues') {
		return;
	}
	const newValue = String(clipboardData.value ?? clipboardData.text ?? '');
	setElementValue(selectedCell.element, newValue, selectedCell.fieldConfig);
	if (selectedCell.usesDropdown) {
		const display = selectedTd?.querySelector('.kv-select-display');
		if (display) {
			updateSelectDisplay(selectedCell.element, display, selectedCell.fieldConfig);
		}
	}
	if (!selectedCell.usesDropdown && formulaValueInput) {
		formulaValueInput.value = newValue;
	}
	handleElementChange(selectedCell.element, selectedCell.fieldConfig);
	selectedCell.value = newValue;
}

function handleClipboardShortcuts(event) {
	if (!selectedCell) {
		return;
	}
	const isCopy = event.key?.toLowerCase() === 'c';
	const isPaste = event.key?.toLowerCase() === 'v';
	if (!(event.ctrlKey || event.metaKey) || (!isCopy && !isPaste)) {
		return;
	}
	if (isEditableElement(document.activeElement)) {
		return;
	}
	event.preventDefault();
	if (isCopy) {
		copySelectedCell();
	} else {
		pasteToSelectedCell();
	}
}

// 处理行级别的复制粘贴快捷键
function handleRowClipboardShortcuts(event) {
	const isCopy = event.key?.toLowerCase() === 'c';
	const isPaste = event.key?.toLowerCase() === 'v';

	if (!(event.ctrlKey || event.metaKey) || (!isCopy && !isPaste)) {
		return;
	}

	// 复制需要有选中的行
	if (isCopy && selectedRows.size === 0) {
		return;
	}

	// 粘贴需要有复制的数据
	if (isPaste && !copiedRowsData) {
		return;
	}

	// 确保不在可编辑元素中
	if (isEditableElement(document.activeElement)) {
		return;
	}

	event.preventDefault();
	event.stopPropagation();

	if (isCopy) {
		copySelectedRows();
	} else if (isPaste) {
		pasteRows();
	}
}

// 切换行选择状态
function toggleRowSelection(rowIndex, multiSelect = false, rangeSelect = false) {
	// 清除单元格选择（行选择和单元格选择互斥）
	if (selectedCell) {
		clearSelection();
	}

	if (!multiSelect && !rangeSelect) {
		// 单选：清除其他选择
		clearRowSelection();
		selectedRows.add(rowIndex);
		lastSelectedRowIndex = rowIndex;
	} else if (multiSelect) {
		// Ctrl 多选：切换当前行
		if (selectedRows.has(rowIndex)) {
			selectedRows.delete(rowIndex);
		} else {
			selectedRows.add(rowIndex);
		}
		lastSelectedRowIndex = rowIndex;
	} else if (rangeSelect && lastSelectedRowIndex !== null) {
		// Shift 范围选择
		const start = Math.min(lastSelectedRowIndex, rowIndex);
		const end = Math.max(lastSelectedRowIndex, rowIndex);
		for (let i = start; i <= end; i++) {
			selectedRows.add(i);
		}
	}

	updateRowSelectionVisuals();
}

// 清除行选择
function clearRowSelection() {
	selectedRows.clear();
	lastSelectedRowIndex = null;
	updateRowSelectionVisuals();
}

// 更新行选择的视觉效果
function updateRowSelectionVisuals() {
	if (!tableSection) {
		return;
	}

	const rows = tableSection.querySelectorAll('tbody tr');
	rows.forEach((row, index) => {
		if (selectedRows.has(index)) {
			row.classList.add('kv-row-selected');
		} else {
			row.classList.remove('kv-row-selected');
		}
	});
}

// 复制选中的行
function copySelectedRows() {
	if (!latestPayload || !Array.isArray(latestPayload.rows) || selectedRows.size === 0) {
		return;
	}

	const rowsToCopy = [];
	const sortedIndices = Array.from(selectedRows).sort((a, b) => a - b);

	for (const rowIndex of sortedIndices) {
		if (rowIndex >= 0 && rowIndex < latestPayload.rows.length) {
			const row = latestPayload.rows[rowIndex];
			// 深拷贝行数据
			const rowCopy = {
				id: row.id,
				values: { ...row.values },
			};

			// 复制 abilityValues 如果存在
			if (row.abilityValues) {
				rowCopy.abilityValues = cloneAbilityValuesEntries(row.abilityValues);
			}

			rowsToCopy.push(rowCopy);
		}
	}

	if (rowsToCopy.length > 0) {
		copiedRowsData = rowsToCopy;
		console.log(`已复制 ${rowsToCopy.length} 行数据`);

		// 可选：显示提示信息
		if (tableSection) {
			showTemporaryMessage(`已复制 ${rowsToCopy.length} 行`, 1000);
		}
	}
}

// 粘贴行
function pasteRows() {
	if (!copiedRowsData || copiedRowsData.length === 0) {
		return;
	}

	// 确定插入位置：如果有选中的行，在最后一个选中行之后插入；否则在表格末尾插入
	let insertAfterIndex = -1;
	if (selectedRows.size > 0) {
		insertAfterIndex = Math.max(...Array.from(selectedRows));
	} else if (latestPayload && latestPayload.rows) {
		insertAfterIndex = latestPayload.rows.length - 1;
	}

	console.log(`[pasteRows] 准备粘贴 ${copiedRowsData.length} 行:`, copiedRowsData);
	console.log(`[pasteRows] 插入位置: ${insertAfterIndex + 1}`);

	// 发送批量插入请求
	vscode.postMessage({
		type: 'bulkInsertRows',
		payload: {
			insertAfterIndex,
			rows: copiedRowsData,
		},
	});

	console.log(`粘贴 ${copiedRowsData.length} 行到位置 ${insertAfterIndex + 1}`);

	// 显示提示信息
	if (tableSection) {
		showTemporaryMessage(`已粘贴 ${copiedRowsData.length} 行`, 1000);
	}
}

// 显示临时提示消息
function showTemporaryMessage(message, duration = 2000) {
	const existingMessage = document.querySelector('.kv-temp-message');
	if (existingMessage) {
		existingMessage.remove();
	}

	const messageEl = document.createElement('div');
	messageEl.className = 'kv-temp-message';
	messageEl.textContent = message;
	messageEl.style.cssText = `
		position: fixed;
		bottom: 20px;
		right: 20px;
		background: var(--vscode-notifications-background, #2d2d30);
		color: var(--vscode-notifications-foreground, #cccccc);
		padding: 10px 16px;
		border-radius: 4px;
		box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
		z-index: 10000;
		font-size: 13px;
		animation: kv-message-slide-in 0.2s ease-out;
	`;

	document.body.appendChild(messageEl);

	setTimeout(() => {
		messageEl.style.animation = 'kv-message-fade-out 0.2s ease-out';
		setTimeout(() => messageEl.remove(), 200);
	}, duration);
}

// 处理 Escape 键清除行选择
function handleEscapeClearSelection(event) {
	if (event.key === 'Escape' && selectedRows.size > 0) {
		event.preventDefault();
		clearRowSelection();
	}
}

// 处理方向键导航和空格键进入编辑状态
function handleCellNavigation(event) {
	// 如果正在编辑状态，不处理导航
	if (isEditableElement(document.activeElement)) {
		return;
	}
	// 如果没有选中单元格，不处理
	if (!selectedCellKey || !latestPayload || !Array.isArray(latestPayload.columns) || !Array.isArray(latestPayload.rows)) {
		return;
	}

	const key = event.key;
	const columns = latestPayload.columns;
	const rows = latestPayload.rows;
	const currentRowIndex = selectedCellKey.rowIndex;
	const currentColumn = selectedCellKey.column;
	const currentColumnIndex = columns.indexOf(currentColumn);

	if (currentColumnIndex < 0 || currentRowIndex < 0) {
		return;
	}

	// 处理空格键进入编辑状态
	if (key === ' ') {
		event.preventDefault();
		if (selectedCell && selectedCell.editable && selectedCell.element) {
			if (selectedCell.element instanceof HTMLInputElement) {
				selectedCell.element.focus();
				selectedCell.element.select();
			} else if (selectedCell.element.focus) {
				selectedCell.element.focus();
			}
		}
		return;
	}

	// 处理方向键导航
	let newRowIndex = currentRowIndex;
	let newColumnIndex = currentColumnIndex;

	switch (key) {
		case 'ArrowUp':
			newRowIndex = Math.max(0, currentRowIndex - 1);
			break;
		case 'ArrowDown':
			newRowIndex = Math.min(rows.length - 1, currentRowIndex + 1);
			break;
		case 'ArrowLeft':
			newColumnIndex = Math.max(0, currentColumnIndex - 1);
			break;
		case 'ArrowRight':
			newColumnIndex = Math.min(columns.length - 1, currentColumnIndex + 1);
			break;
		default:
			return; // 不是方向键，不处理
	}

	// 如果位置没有变化，不处理
	if (newRowIndex === currentRowIndex && newColumnIndex === currentColumnIndex) {
		return;
	}

	event.preventDefault();

	// 找到目标单元格并选中
	const newColumn = columns[newColumnIndex];
	const selector = `td[data-column="${newColumn}"][data-row-index="${newRowIndex}"]`;
	const targetTd = tableSection?.querySelector(selector);

	if (targetTd) {
		// 直接构建 context 并调用 selectCell，而不是使用 click() 来避免自动进入编辑状态
		const rowId = targetTd.dataset.rowId ?? '';
		const isAbilityColumn = newColumn === 'AbilityValues';
		const editable = newColumn !== ROW_NUMBER_COLUMN_KEY && !isAbilityColumn;
		const fieldConfig = columnOptionConfig[newColumn];
		const usesDropdown = Boolean(fieldConfig?.options?.length);
		let element = null;
		if (editable) {
			element = usesDropdown ? targetTd.querySelector('select') : targetTd.querySelector('input');
		}
		const value = isAbilityColumn
			? (targetTd.dataset.displayValue ?? targetTd.textContent ?? '')
			: editable
				? readElementValue(element, fieldConfig)
				: (targetTd.textContent ?? '');
		const abilityEntries = isAbilityColumn ? parseAbilityEntriesFromCell(targetTd) : undefined;
		const hasAbilityField = isAbilityColumn ? targetTd.dataset.hasAbilityField === 'true' : false;

		// 获取列字母和列名
		const columnLetter = getColumnLetter(newColumnIndex);
		const columnName = latestPayload.columnLabels?.[newColumn] ?? newColumn;

		selectCell(targetTd, {
			column: newColumn,
			columnLetter,
			columnName,
			rowId,
			rowIndex: newRowIndex,
			editable,
			element,
			fieldConfig,
			usesDropdown,
			value,
			dataType: isAbilityColumn ? 'abilityValues' : 'cell',
			abilityEntries,
			hasAbilityField
		});

		// 确保单元格可见
		targetTd.scrollIntoView({ block: 'nearest', inline: 'nearest' });
	}
}

function handleClipboardShortcuts(event) {
	if (!selectedCell) {
		return;
	}
	const isCopy = event.key?.toLowerCase() === 'c';
	const isPaste = event.key?.toLowerCase() === 'v';
	if (!(event.ctrlKey || event.metaKey) || (!isCopy && !isPaste)) {
		return;
	}
	if (isEditableElement(document.activeElement)) {
		return;
	}
	event.preventDefault();
	if (isCopy) {
		copySelectedCell();
	} else {
		pasteToSelectedCell();
	}
}

function startFillDrag(event) {
	if (event.button !== 0) {
		return;
	}
	if (!selectedTd || !selectedCell || !selectedCell.editable) {
		return;
	}
	event.preventDefault();
	event.stopPropagation();
	closeFillPopup();
	clearFillPreview();
	const rect = selectedTd.getBoundingClientRect();
	fillHandleState = {
		startRow: selectedCell.rowIndex,
		currentRow: selectedCell.rowIndex,
		column: selectedCell.column,
		startClientX: event.clientX,
		startClientY: event.clientY,
		moved: false,
	};
	document.addEventListener('mousemove', handleFillDragMove);
	document.addEventListener('mouseup', handleFillDragEnd);
}

function handleFillDragMove(event) {
	if (!fillHandleState || !selectedTd) {
		return;
	}
	const deltaX = Math.abs(event.clientX - fillHandleState.startClientX);
	const deltaY = event.clientY - fillHandleState.startClientY;
	if (!fillHandleState.moved) {
		if (Math.abs(deltaY) < 4 && deltaX > 6) {
			return;
		}
		if (Math.abs(deltaY) < 2 && Math.abs(deltaX) < 2) {
			return;
		}
		if (deltaX > Math.abs(deltaY)) {
			return;
		}
		fillHandleState.moved = true;
	}

	// 自动滚动逻辑
	if (tableSection) {
		const tableRect = tableSection.getBoundingClientRect();
		const scrollThreshold = 50; // 距离边缘多少像素开始滚动
		const scrollSpeed = 50; // 每次滚动的像素数

		// 鼠标距离表格顶部和底部的距离
		const distanceFromTop = event.clientY - tableRect.top;
		const distanceFromBottom = tableRect.bottom - event.clientY;

		// 向上滚动：距离顶部小于阈值（包括超出顶部边缘）
		if (distanceFromTop < scrollThreshold) {
			const normalizedDistance = Math.max(0, distanceFromTop);
			const scrollAmount = Math.max(1, scrollSpeed * (1 - normalizedDistance / scrollThreshold));
			tableSection.scrollTop = Math.max(0, tableSection.scrollTop - scrollAmount);
		}
		// 向下滚动：距离底部小于阈值（包括超出底部边缘）
		else if (distanceFromBottom < scrollThreshold) {
			const normalizedDistance = Math.max(0, distanceFromBottom);
			const scrollAmount = Math.max(1, scrollSpeed * (1 - normalizedDistance / scrollThreshold));
			const maxScroll = tableSection.scrollHeight - tableSection.clientHeight;
			tableSection.scrollTop = Math.min(maxScroll, tableSection.scrollTop + scrollAmount);
		}
	}

	const targetRow = resolveFillTargetRow(event.clientY);
	if (targetRow === null || targetRow === fillHandleState.currentRow) {
		return;
	}
	fillHandleState.currentRow = targetRow;
	updateFillPreview();
}

function resolveFillTargetRow(clientY) {
	const rows = latestPayload?.rows;
	if (!Array.isArray(rows) || !selectedTd) {
		return null;
	}
	const tableRect = tableSection?.getBoundingClientRect();
	if (!tableRect) {
		return null;
	}
	const rowElements = tableSection.querySelectorAll('tbody tr');
	let closestRow = null;
	let closestDistance = Number.POSITIVE_INFINITY;
	rowElements.forEach((row) => {
		const rect = row.getBoundingClientRect();
		const mid = rect.top + rect.height / 2;
		const distance = Math.abs(clientY - mid);
		if (distance < closestDistance) {
			closestDistance = distance;
			const index = Number(row.dataset.rowIndex ?? '-1');
			if (Number.isFinite(index)) {
				closestRow = index;
			}
		}
	});
	if (closestRow === null) {
		return null;
	}
	return closestRow;
}

function handleFillDragEnd(event) {
	document.removeEventListener('mousemove', handleFillDragMove);
	document.removeEventListener('mouseup', handleFillDragEnd);
	if (!fillHandleState) {
		return;
	}
	if (!fillHandleState.moved) {
		fillHandleState = null;
		return;
	}
	event.preventDefault();
	openFillPopup();
}

// 还原公式栏内容到单元格初始值
function revertFormulaValue() {
	if (!selectedCell || !selectedCell.element) {
		return;
	}
	const original = selectedCell.element.dataset.initialValue ?? '';
	setElementValue(selectedCell.element, original, selectedCell.fieldConfig);
	if (formulaValueInput) {
		if (selectedCell.formula) {
			formulaValueInput.value = selectedCell.formula;
		} else {
			formulaValueInput.value = original;
		}
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
	const trimmedValue = newValue.trim();
	const isFormula = trimmedValue.startsWith('=');

	// 对于公式，需要特殊处理以避免显示公式文本
	if (isFormula) {
		const previousFormula = selectedCell.element.dataset.formulaValue ?? '';
		// 如果公式没有变化，无需处理
		if (previousFormula === trimmedValue) {
			return;
		}
		// 临时设置公式文本以便 handleElementChange 检测
		setElementValue(selectedCell.element, trimmedValue, selectedCell.fieldConfig);
		handleElementChange(selectedCell.element, selectedCell.fieldConfig);
		// handleElementChange 会调用 refreshFormulaResultsForTable 更新显示
		// 但为了避免 focus 事件读取到公式文本，立即恢复显示计算结果
		if (selectedCell.rowIndex !== undefined && selectedCell.column) {
			const computed = getComputedFormulaEntry(selectedCell.column, selectedCell.rowIndex);
			if (computed && typeof computed.value === 'string') {
				setElementValue(selectedCell.element, computed.value, selectedCell.fieldConfig);
			}
		}
	} else {
		// 普通值的处理
		const current = readElementValue(selectedCell.element, selectedCell.fieldConfig);
		const initial = selectedCell.element.dataset.initialValue ?? '';
		if (current === newValue && initial === newValue) {
			return;
		}
		setElementValue(selectedCell.element, newValue, selectedCell.fieldConfig);
		handleElementChange(selectedCell.element, selectedCell.fieldConfig);
	}
}

// 获取字段配置中定义的分隔符
// 为输入框添加撤销/重做支持
function setupUndoRedo(input, maxHistory = 50) {
	if (!input || !(input instanceof HTMLInputElement)) {
		return;
	}

	// 初始化撤销历史
	if (!input.dataset.undoHistory) {
		input.dataset.undoHistory = JSON.stringify([input.value || '']);
		input.dataset.undoIndex = '0';
	}

	// 处理撤销/重做快捷键
	const handleKeyDown = (event) => {
		const isUndo = event.key === 'z' && (event.ctrlKey || event.metaKey) && !event.shiftKey;
		const isRedo = (event.key === 'z' && (event.ctrlKey || event.metaKey) && event.shiftKey) ||
			(event.key === 'y' && (event.ctrlKey || event.metaKey));

		if (isUndo || isRedo) {
			event.preventDefault();
			const history = JSON.parse(input.dataset.undoHistory || '[]');
			let index = parseInt(input.dataset.undoIndex || '0');

			if (isUndo && index > 0) {
				index--;
				input.dataset.undoIndex = String(index);
				input.value = history[index] || '';
				// 触发 change 事件以同步状态
				const changeEvent = new Event('change', { bubbles: true });
				input.dispatchEvent(changeEvent);
			} else if (isRedo && index < history.length - 1) {
				index++;
				input.dataset.undoIndex = String(index);
				input.value = history[index] || '';
				// 触发 change 事件以同步状态
				const changeEvent = new Event('change', { bubbles: true });
				input.dispatchEvent(changeEvent);
			}
		}
	};

	// 保存撤销历史
	const handleInput = () => {
		const history = JSON.parse(input.dataset.undoHistory || '[]');
		let index = parseInt(input.dataset.undoIndex || '0');
		const currentValue = input.value;

		// 如果当前值与历史中的值不同，则添加到历史
		if (history[index] !== currentValue) {
			// 删除当前索引之后的所有历史
			history.splice(index + 1);
			// 添加新值
			history.push(currentValue);
			// 限制历史记录数量
			if (history.length > maxHistory) {
				history.shift();
			} else {
				index++;
			}
			input.dataset.undoHistory = JSON.stringify(history);
			input.dataset.undoIndex = String(index);
		}
	};

	input.addEventListener('keydown', handleKeyDown);
	input.addEventListener('input', handleInput);
}

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

function clearFillPreview() {
	for (const cell of fillPreviewCells) {
		if (cell && cell.classList) {
			cell.classList.remove('kv-cell-fill-preview');
		}
	}
	fillPreviewCells = [];
}

function detachFillHandle() {
	if (fillHandleElement && fillHandleElement.parentElement) {
		fillHandleElement.parentElement.removeChild(fillHandleElement);
	}
	fillHandleElement = null;
}

function refreshFillHandle() {
	if (!selectedTd || !selectedCell || !selectedCell.editable || selectedCell.dataType !== 'cell' || !selectedCell.element) {
		detachFillHandle();
		return;
	}
	if (!fillHandleElement) {
		fillHandleElement = document.createElement('div');
		fillHandleElement.className = 'kv-cell-fill-handle';
		fillHandleElement.title = '拖动以快速填充';
		fillHandleElement.addEventListener('mousedown', (event) => startFillDrag(event));
	}
	const host = selectedTd;
	host.style.position = 'relative';
	if (fillHandleElement.parentElement !== host) {
		host.appendChild(fillHandleElement);
	}
}

function updateFillPreview() {
	clearFillPreview();
	if (!fillHandleState || !selectedCell || !selectedTd) {
		return;
	}
	const startRow = fillHandleState.startRow;
	const endRow = fillHandleState.currentRow;
	if (endRow === null || endRow === startRow) {
		return;
	}
	const step = endRow > startRow ? 1 : -1;
	for (let rowIndex = startRow + step; step > 0 ? rowIndex <= endRow : rowIndex >= endRow; rowIndex += step) {
		const cell = tableSection?.querySelector(`td[data-column="${fillHandleState.column}"][data-row-index="${rowIndex}"]`);
		if (cell) {
			cell.classList.add('kv-cell-fill-preview');
			fillPreviewCells.push(cell);
		}
	}
}

function computeFillTargetRows(startRow, endRow) {
	if (!Number.isFinite(startRow) || !Number.isFinite(endRow) || startRow === endRow) {
		return [];
	}
	const step = endRow > startRow ? 1 : -1;
	const rows = [];
	for (let rowIndex = startRow + step; step > 0 ? rowIndex <= endRow : rowIndex >= endRow; rowIndex += step) {
		rows.push(rowIndex);
	}
	return rows;
}

function getEditableCellContext(rowIndex, columnKey) {
	if (!tableSection) {
		return null;
	}
	const selector = `td[data-column="${columnKey}"][data-row-index="${rowIndex}"]`;
	const cell = tableSection.querySelector(selector);
	if (!cell) {
		return null;
	}
	const fieldConfig = columnOptionConfig?.[columnKey];
	const usesDropdown = Boolean(fieldConfig?.options?.length);
	const element = cell.querySelector(usesDropdown ? 'select' : 'input');
	if (!element) {
		return null;
	}
	return {
		cell,
		element,
		fieldConfig,
		usesDropdown,
		id: element.dataset.id ?? '',
		rowId: cell.dataset.rowId ?? '',
		rowIndex: Number(cell.dataset.rowIndex ?? `${rowIndex}`),
	};
}

function isValueAvailableInSelect(selectElement, value) {
	if (!(selectElement instanceof HTMLSelectElement)) {
		return true;
	}
	return Array.from(selectElement.options).some((option) => option.value === value);
}

function closeFillPopup(options = {}) {
	if (!fillPopupState) {
		fillHandleState = null;
		return;
	}
	const { element, keyHandler, outsideHandler, scrollHandler, resizeHandler } = fillPopupState;
	if (element && element.parentElement) {
		element.parentElement.removeChild(element);
	}
	if (keyHandler) {
		document.removeEventListener('keydown', keyHandler, true);
	}
	if (outsideHandler) {
		document.removeEventListener('mousedown', outsideHandler, true);
	}
	if (scrollHandler) {
		tableSection?.removeEventListener('scroll', scrollHandler);
	}
	if (resizeHandler) {
		window.removeEventListener('resize', resizeHandler);
	}
	fillPopupState = null;
	fillHandleState = null;
	if (options.clearPreview !== false) {
		clearFillPreview();
	}
	refreshFillHandle();
}

function showFillPopupError(message) {
	if (!fillPopupState || !fillPopupState.errorElement) {
		return;
	}
	fillPopupState.errorElement.textContent = message ?? '';
	fillPopupState.errorElement.hidden = !message;
}

function clearFillPopupError() {
	showFillPopupError('');
}

function openFillPopup() {
	if (!fillHandleState || !selectedCell || !selectedTd) {
		fillHandleState = null;
		clearFillPreview();
		refreshFillHandle();
		return;
	}
	const { startRow, currentRow, column } = fillHandleState;
	if (!Number.isFinite(startRow) || !Number.isFinite(currentRow) || startRow === currentRow) {
		fillHandleState = null;
		clearFillPreview();
		refreshFillHandle();
		return;
	}
	const targetRows = computeFillTargetRows(startRow, currentRow);
	if (!targetRows.length) {
		fillHandleState = null;
		clearFillPreview();
		refreshFillHandle();
		return;
	}
	closeFillPopup({ clearPreview: false });
	const popup = document.createElement('div');
	popup.className = 'kv-fill-popup';
	popup.setAttribute('role', 'dialog');
	popup.setAttribute('aria-label', '填充选项');
	const title = document.createElement('div');
	title.className = 'kv-fill-popup-title';
	const direction = currentRow > startRow ? 1 : -1;
	title.textContent = `填充 ${direction > 0 ? '向下' : '向上'} ${targetRows.length} 行`;
	popup.appendChild(title);
	const form = document.createElement('form');
	form.className = 'kv-fill-popup-form';
	const modeList = document.createElement('div');
	modeList.className = 'kv-fill-popup-modes';
	const baseFormula = getSelectedCellFormulaValue();
	const hasBaseFormula = baseFormula.length > 0;
	const modes = hasBaseFormula
		? [
			{ value: 'formulaSequence', label: '序列' },
			{ value: 'copy', label: '复制' },
		]
		: [
			{ value: 'copy', label: '复制' },
			{ value: 'arithmetic', label: '等差填充' },
			{ value: 'geometric', label: '等比填充' },
			{ value: 'formula', label: '公式填充' }
		];
	const modeInputs = [];
	modes.forEach((mode, index) => {
		const item = document.createElement('label');
		item.className = 'kv-fill-popup-mode';
		const input = document.createElement('input');
		input.type = 'radio';
		input.name = 'fill-mode';
		input.value = mode.value;
		input.className = 'kv-radio-input';
		if (index === 0) {
			input.checked = true;
		}
		const indicator = document.createElement('span');
		indicator.className = 'kv-radio-indicator codicon codicon-circle-large-outline';
		const span = document.createElement('span');
		span.className = 'kv-radio-label';
		span.textContent = mode.label;
		if (mode.value === 'formula') {
			item.title = FORMULA_TOOLTIP_HELP;
		}
		item.appendChild(input);
		item.appendChild(indicator);
		item.appendChild(span);
		modeList.appendChild(item);
		modeInputs.push(input);
	});
	form.appendChild(modeList);
	const arithmeticWrapper = document.createElement('div');
	arithmeticWrapper.className = 'kv-fill-popup-field';
	arithmeticWrapper.hidden = true;
	const arithmeticLabel = document.createElement('label');
	arithmeticLabel.textContent = '步长';
	const arithmeticInput = document.createElement('input');
	arithmeticInput.type = 'number';
	arithmeticInput.value = String(FILL_DEFAULT_STEP);
	arithmeticInput.step = 'any';
	arithmeticWrapper.appendChild(arithmeticLabel);
	arithmeticWrapper.appendChild(arithmeticInput);
	form.appendChild(arithmeticWrapper);
	const geometricWrapper = document.createElement('div');
	geometricWrapper.className = 'kv-fill-popup-field';
	geometricWrapper.hidden = true;
	const geometricLabel = document.createElement('label');
	geometricLabel.textContent = '比率';
	const geometricInput = document.createElement('input');
	geometricInput.type = 'number';
	geometricInput.value = String(FILL_DEFAULT_RATIO);
	geometricInput.step = 'any';
	geometricWrapper.appendChild(geometricLabel);
	geometricWrapper.appendChild(geometricInput);
	form.appendChild(geometricWrapper);
	const formulaWrapper = document.createElement('div');
	formulaWrapper.className = 'kv-fill-popup-field';
	formulaWrapper.hidden = true;
	const formulaLabel = document.createElement('label');
	formulaLabel.textContent = '表达式 (可用: base, baseNumber, offset, rowIndex, rowNumber, direction)';
	const formulaInput = document.createElement('input');
	formulaInput.type = 'text';
	formulaInput.placeholder = '例如: base + offset * 2';
	formulaWrapper.appendChild(formulaLabel);
	formulaWrapper.appendChild(formulaInput);
	form.appendChild(formulaWrapper);
	const errorEl = document.createElement('div');
	errorEl.className = 'kv-fill-popup-error';
	errorEl.hidden = true;
	form.appendChild(errorEl);
	const actions = document.createElement('div');
	actions.className = 'kv-fill-popup-actions';
	const cancelButton = document.createElement('button');
	cancelButton.type = 'button';
	cancelButton.className = 'kv-button kv-button-secondary';
	cancelButton.textContent = '取消';
	actions.appendChild(cancelButton);
	const applyButton = document.createElement('button');
	applyButton.type = 'submit';
	applyButton.className = 'kv-button kv-button-primary';
	applyButton.textContent = '填充';
	actions.appendChild(applyButton);
	form.appendChild(actions);
	popup.appendChild(form);
	const handleModeVisibility = () => {
		const currentMode = modeInputs.find((input) => input.checked)?.value ?? 'copy';
		arithmeticWrapper.hidden = currentMode !== 'arithmetic';
		geometricWrapper.hidden = currentMode !== 'geometric';
		formulaWrapper.hidden = currentMode !== 'formula';
		clearFillPopupError();
	};
	modeInputs.forEach((input) => {
		input.addEventListener('change', handleModeVisibility);
	});
	form.addEventListener('submit', (event) => {
		event.preventDefault();
		handleFillApply();
	});
	cancelButton.addEventListener('click', () => {
		closeFillPopup();
	});
	const keyHandler = (event) => {
		if (event.key === 'Escape') {
			event.preventDefault();
			closeFillPopup();
		} else if (event.key === 'Enter' && event.target instanceof HTMLElement && popup.contains(event.target) && !(event.target instanceof HTMLTextAreaElement)) {
			event.preventDefault();
			handleFillApply();
		}
	};
	const outsideHandler = (event) => {
		if (!popup.contains(event.target)) {
			closeFillPopup();
		}
	};
	document.addEventListener('keydown', keyHandler, true);
	document.addEventListener('mousedown', outsideHandler, true);
	const scrollHandler = () => positionFillPopup();
	const resizeHandler = () => positionFillPopup();
	tableSection?.addEventListener('scroll', scrollHandler, { passive: true });
	window.addEventListener('resize', resizeHandler, { passive: true });
	document.body.appendChild(popup);
	fillPopupState = {
		element: popup,
		errorElement: errorEl,
		modeInputs,
		arithmeticInput,
		geometricInput,
		formulaInput,
		targetRows,
		column,
		direction,
		startRow,
		endRow: currentRow,
		keyHandler,
		outsideHandler,
		scrollHandler,
		resizeHandler,
		hasBaseFormula,
	};
	positionFillPopup();
	requestAnimationFrame(() => positionFillPopup());
	handleModeVisibility();
	focusFillPopup(modeInputs, arithmeticInput, formulaInput);
	fillHandleState = null;
}

function focusFillPopup(modeInputs, arithmeticInput, formulaInput) {
	const mode = modeInputs.find((input) => input.checked)?.value ?? 'copy';
	switch (mode) {
		case 'arithmetic':
			arithmeticInput.focus();
			arithmeticInput.select();
			break;
		case 'formula':
			formulaInput.focus();
			formulaInput.select();
			break;
		default:
			modeInputs[0]?.focus();
			break;
	}
}

function positionFillPopup() {
	if (!fillPopupState || !fillPopupState.element) {
		return;
	}
	const { element, targetRows, column, direction } = fillPopupState;
	const anchorRow = direction > 0 ? targetRows[targetRows.length - 1] : targetRows[0];
	const anchorSelector = `td[data-column="${column}"][data-row-index="${anchorRow}"]`;
	const anchorCell = tableSection?.querySelector(anchorSelector) || selectedTd;
	if (!anchorCell) {
		return;
	}
	const rect = anchorCell.getBoundingClientRect();
	const popupRect = element.getBoundingClientRect();
	let top = direction > 0 ? rect.bottom + 4 : rect.top - popupRect.height - 4;
	let left = rect.right - popupRect.width;
	const viewportHeight = window.innerHeight;
	const viewportWidth = window.innerWidth;
	if (top + popupRect.height > viewportHeight - 8) {
		top = viewportHeight - popupRect.height - 8;
	}
	if (top < 8) {
		top = 8;
	}
	if (left + popupRect.width > viewportWidth - 8) {
		left = viewportWidth - popupRect.width - 8;
	}
	if (left < 8) {
		left = 8;
	}
	element.style.top = `${Math.round(top)}px`;
	element.style.left = `${Math.round(left)}px`;
}

function getSelectedFillMode() {
	if (!fillPopupState?.modeInputs) {
		return 'copy';
	}
	return fillPopupState.modeInputs.find((input) => input.checked)?.value ?? 'copy';
}

function handleFillApply() {
	if (!fillPopupState) {
		return;
	}
	const mode = getSelectedFillMode();
	let result;
	switch (mode) {
		case 'copy':
			result = performCopyFill();
			break;
		case 'formulaSequence':
			result = performFormulaSequenceFill();
			break;
		case 'arithmetic':
			result = performArithmeticFill();
			break;
		case 'geometric':
			result = performGeometricFill();
			break;
		case 'formula':
			result = performFormulaFill();
			break;
		default:
			result = { success: false, message: '未知填充模式' };
			break;
	}
	if (result?.success) {
		closeFillPopup();
	} else if (result?.message) {
		showFillPopupError(result.message);
	}
}

function prepareFillOperation({ allowDropdown }) {
	if (!fillPopupState || !selectedCell) {
		return { success: false, message: '当前没有可填充的单元格' };
	}
	const columnKey = fillPopupState.column;
	if (!columnKey) {
		return { success: false, message: '无法确定填充列' };
	}
	const baseValueRaw = selectedCell.element
		? readElementValue(selectedCell.element, selectedCell.fieldConfig)
		: (selectedCell.value ?? '');
	const targetRows = Array.isArray(fillPopupState.targetRows) ? fillPopupState.targetRows.slice() : [];
	if (!targetRows.length) {
		return { success: false, message: '请选择需要填充的范围' };
	}
	const contexts = [];
	for (const rowIndex of targetRows) {
		const context = getEditableCellContext(rowIndex, columnKey);
		if (!context) {
			return { success: false, message: '目标区域包含不可编辑的单元格' };
		}
		if (context.usesDropdown && !allowDropdown) {
			return { success: false, message: '该填充模式不支持下拉字段' };
		}
		if (!context.id) {
			return { success: false, message: '目标行缺少唯一标识，无法写入。' };
		}
		contexts.push(context);
	}
	return {
		success: true,
		baseValueRaw,
		contexts,
		targetRows,
		column: columnKey,
	};
}

function getSelectedCellFormulaValue() {
	const direct = typeof selectedCell?.formula === 'string' ? selectedCell.formula : '';
	const fallback = selectedCell?.element?.dataset?.formulaValue ?? '';
	const candidate = direct && direct.trim().length ? direct : fallback;
	const trimmed = typeof candidate === 'string' ? candidate.trim() : '';
	return trimmed.startsWith('=') ? trimmed : '';
}

function offsetFormulaReferences(formula, rowOffset) {
	const trimmed = typeof formula === 'string' ? formula.trim() : '';
	if (!trimmed.startsWith('=') || !Number.isFinite(rowOffset) || rowOffset === 0) {
		return trimmed;
	}
	const expression = trimmed.slice(1);
	const rewrite = replaceCellReferencesInExpression(expression, (columnLetter, rowNumber) => {
		const nextRow = Number(rowNumber) + rowOffset;
		if (!Number.isFinite(nextRow) || nextRow <= 0) {
			return `${columnLetter}${rowNumber}`;
		}
		return `${columnLetter}${Math.floor(nextRow)}`;
	});
	return `=${rewrite.text}`;
}

function applyFormulaDefinitionsToContexts(columnKey, contexts, formulaFactory) {
	if (!Array.isArray(contexts) || !contexts.length) {
		return { success: false, message: '没有可填充的单元格。' };
	}
	const updates = [];
	contexts.forEach((context, index) => {
		if (!context || !context.element) {
			return;
		}
		const formula = formulaFactory(context, index);
		const trimmed = typeof formula === 'string' ? formula.trim() : '';
		if (!trimmed.startsWith('=')) {
			return;
		}
		const targetRowIndex = Number.isFinite(context.rowIndex) ? Number(context.rowIndex) : undefined;
		if (targetRowIndex === undefined || targetRowIndex < 0) {
			return;
		}
		const rowId = typeof context.id === 'string' && context.id.length
			? context.id
			: (typeof context.rowId === 'string' ? context.rowId : '');
		context.element.dataset.formulaValue = trimmed;
		setElementValue(context.element, trimmed, context.fieldConfig);
		context.element.dataset.initialValue = trimmed;
		setFormulaDefinition(columnKey, rowId, targetRowIndex, trimmed);
		updates.push({ column: columnKey, rowId, rowIndex: targetRowIndex, formula: trimmed });
	});
	if (!updates.length) {
		return { success: false, message: '未生成可写入的公式。' };
	}
	updatePayloadFormulasSnapshot();
	recalculateFormulas({ emitUpdates: true });
	refreshFormulaResultsForTable();
	updates.forEach((entry) => postSaveFormulaMessage(entry));
	return { success: true };
}

function applyValueToContext(context, value, columnKey, collector) {
	setElementValue(context.element, value, context.fieldConfig);
	if (context.usesDropdown) {
		const display = context.cell.querySelector('.kv-select-display');
		if (display) {
			updateSelectDisplay(context.element, display, context.fieldConfig);
		}
	}
	const normalizedValue = readElementValue(context.element, context.fieldConfig);
	context.element.dataset.initialValue = normalizedValue;
	context.element.title = normalizedValue;
	if (!context.usesDropdown && formulaValueInput && selectedCell?.element === context.element) {
		formulaValueInput.value = normalizedValue;
	}
	if (selectedCell && selectedCell.element === context.element) {
		selectedCell.value = normalizedValue;
	}
	updateCachedRowValue(context.rowIndex, columnKey, normalizedValue);
	if (Array.isArray(collector) && context.id) {
		collector.push({ id: context.id, key: columnKey, value: normalizedValue });
	}
}

function updateCachedRowValue(rowIndex, columnKey, value) {
	if (!Array.isArray(latestPayload?.rows)) {
		return;
	}
	const row = latestPayload.rows[rowIndex];
	if (!row) {
		return;
	}
	if (!row.values || typeof row.values !== 'object') {
		row.values = {};
	}
	row.values[columnKey] = value;
}

function dispatchBulkEdit(edits) {
	if (!Array.isArray(edits) || !edits.length) {
		return;
	}
	const filtered = edits.filter((edit) => edit && edit.id && edit.key);
	if (!filtered.length) {
		return;
	}
	vscode.postMessage({
		type: 'bulkEdit',
		payload: {
			edits: filtered.map((edit) => ({
				id: edit.id,
				key: edit.key,
				value: edit.value === undefined || edit.value === null ? '' : String(edit.value),
			})),
		},
	});
}

function formatNumericValueWithTemplate(value, template) {
	if (typeof template === 'string' && template.includes('.')) {
		const decimals = template.split('.')[1]?.length ?? 0;
		if (decimals > 0) {
			return value.toFixed(decimals);
		}
	}
	return String(value);
}

function performCopyFill() {
	const baseFormula = getSelectedCellFormulaValue();
	const prepared = prepareFillOperation({ allowDropdown: !baseFormula });
	if (!prepared.success) {
		return prepared;
	}
	const { baseValueRaw, contexts, column } = prepared;
	if (baseFormula) {
		const result = applyFormulaDefinitionsToContexts(column, contexts, () => baseFormula);
		if (result.success) {
			clearFillPreview();
		}
		return result;
	}
	for (const context of contexts) {
		if (context.usesDropdown && !isValueAvailableInSelect(context.element, baseValueRaw)) {
			return { success: false, message: '目标下拉列表中不存在要复制的值' };
		}
	}
	const edits = [];
	for (const context of contexts) {
		applyValueToContext(context, baseValueRaw, column, edits);
	}
	dispatchBulkEdit(edits);
	clearFillPreview();
	return { success: true };
}

function performFormulaSequenceFill() {
	const baseFormula = getSelectedCellFormulaValue();
	if (!baseFormula) {
		return { success: false, message: '当前单元格不是公式，无法使用序列填充。' };
	}
	const prepared = prepareFillOperation({ allowDropdown: false });
	if (!prepared.success) {
		return prepared;
	}
	const baseRowIndex = Number.isFinite(selectedCell?.rowIndex) ? Number(selectedCell.rowIndex) : undefined;
	if (baseRowIndex === undefined) {
		return { success: false, message: '无法确定公式的基准行。' };
	}
	const { contexts, column } = prepared;
	const result = applyFormulaDefinitionsToContexts(column, contexts, (context) => {
		const targetRowIndex = Number(context.rowIndex);
		const offset = Number.isFinite(targetRowIndex) ? targetRowIndex - baseRowIndex : 0;
		return offsetFormulaReferences(baseFormula, offset);
	});
	if (result.success) {
		clearFillPreview();
	}
	return result;
}

function performArithmeticFill() {
	if (selectedCell?.usesDropdown) {
		return { success: false, message: '当前单元格不支持等差填充' };
	}
	const prepared = prepareFillOperation({ allowDropdown: false });
	if (!prepared.success) {
		return prepared;
	}
	const { baseValueRaw, contexts, column } = prepared;
	const baseNumber = Number(baseValueRaw);
	if (!Number.isFinite(baseNumber)) {
		return { success: false, message: '当前单元格的值不是有效的数字' };
	}
	const stepInput = fillPopupState?.arithmeticInput;
	const stepValue = stepInput ? Number(stepInput.value) : NaN;
	if (!Number.isFinite(stepValue)) {
		return { success: false, message: '请输入有效的步长' };
	}
	const direction = fillPopupState?.direction ?? 1;
	const edits = [];
	contexts.forEach((context, index) => {
		const offset = index + 1;
		const valueNumber = baseNumber + stepValue * (direction > 0 ? offset : -offset);
		const newValue = formatNumericValueWithTemplate(valueNumber, baseValueRaw);
		applyValueToContext(context, newValue, column, edits);
	});
	dispatchBulkEdit(edits);
	clearFillPreview();
	return { success: true };
}

function performGeometricFill() {
	if (selectedCell?.usesDropdown) {
		return { success: false, message: '当前单元格不支持等比填充' };
	}
	const prepared = prepareFillOperation({ allowDropdown: false });
	if (!prepared.success) {
		return prepared;
	}
	const { baseValueRaw, contexts, column } = prepared;
	const baseNumber = Number(baseValueRaw);
	if (!Number.isFinite(baseNumber)) {
		return { success: false, message: '当前单元格的值不是有效的数字' };
	}
	const ratioInput = fillPopupState?.geometricInput;
	const ratioValue = ratioInput ? Number(ratioInput.value) : NaN;
	if (!Number.isFinite(ratioValue) || ratioValue === 0) {
		return { success: false, message: '请输入有效的比率' };
	}
	const direction = fillPopupState?.direction ?? 1;
	const edits = [];
	contexts.forEach((context, index) => {
		const offset = index + 1;
		const factor = Math.pow(ratioValue, offset);
		const valueNumber = direction > 0 ? baseNumber * factor : baseNumber / factor;
		const newValue = formatNumericValueWithTemplate(valueNumber, baseValueRaw);
		applyValueToContext(context, newValue, column, edits);
	});
	dispatchBulkEdit(edits);
	clearFillPreview();
	return { success: true };
}

function performFormulaFill() {
	if (selectedCell?.usesDropdown) {
		return { success: false, message: '当前单元格不支持公式填充' };
	}
	const prepared = prepareFillOperation({ allowDropdown: false });
	if (!prepared.success) {
		return prepared;
	}
	const { baseValueRaw, contexts, column } = prepared;
	const expression = (fillPopupState?.formulaInput?.value ?? '').trim();
	if (!expression) {
		return { success: false, message: '请输入公式表达式' };
	}
	let evaluator;
	try {
		evaluator = new Function('base', 'baseNumber', 'offset', 'rowIndex', 'rowNumber', 'direction', 'rowId', 'toNumber', `return (${expression});`);
	} catch (error) {
		return { success: false, message: `公式解析失败: ${error.message}` };
	}
	const baseNumber = Number(baseValueRaw);
	const direction = fillPopupState?.direction ?? 1;
	const edits = [];
	for (let index = 0; index < contexts.length; index += 1) {
		const context = contexts[index];
		const offset = index + 1;
		const signedOffset = direction > 0 ? offset : -offset;
		let resultValue;
		try {
			resultValue = evaluator(
				baseValueRaw,
				numberOrNull(baseNumber),
				signedOffset,
				context.rowIndex,
				context.rowIndex + 1,
				direction,
				context.rowId,
				(value) => Number(value)
			);
		} catch (error) {
			return { success: false, message: `公式执行失败: ${error.message}` };
		}
		const finalValue = formatFormulaResult(resultValue, baseValueRaw);
		applyValueToContext(context, finalValue, column, edits);
	}
	dispatchBulkEdit(edits);
	clearFillPreview();
	return { success: true };
}

function numberOrNull(value) {
	return Number.isFinite(value) ? value : null;
}

function formatFormulaResult(result, template) {
	if (result === undefined || result === null) {
		return '';
	}
	if (typeof result === 'number') {
		if (Number.isFinite(result)) {
			return formatNumericValueWithTemplate(result, template);
		}
		return String(result);
	}
	return String(result);
}

function resolveRowIndex(rowId, fallbackIndex) {
	if (Number.isFinite(fallbackIndex) && fallbackIndex >= 0) {
		return Math.floor(Number(fallbackIndex));
	}
	if (!Array.isArray(latestPayload?.rows)) {
		return undefined;
	}
	if (typeof rowId === 'string' && rowId.length) {
		const index = latestPayload.rows.findIndex((row) => row && row.id === rowId);
		return index >= 0 ? index : undefined;
	}
	return undefined;
}

// 处理单元格数据变动并通知扩展端
function handleElementChange(element, fieldConfig) {
	if (!element) {
		return;
	}
	const id = element.dataset.id;
	const key = element.dataset.key;
	const columnKey = typeof key === 'string' ? key.trim() : '';
	if (!columnKey) {
		return;
	}
	const rowIndex = resolveRowIndex(id, Number(element.dataset.rowIndex));
	const currentValueRaw = readElementValue(element, fieldConfig);
	const currentValue = currentValueRaw === undefined || currentValueRaw === null ? '' : String(currentValueRaw);
	const trimmedValue = currentValue.trim();

	// 特殊处理 id 列的修改
	if (columnKey === 'id') {
		const oldId = element.dataset.initialValue ?? '';
		const newId = trimmedValue;
		if (oldId === newId) {
			return;
		}
		if (!oldId || !newId) {
			console.warn('[kv-editor] id 列的值不能为空', { oldId, newId });
			// 恢复原值
			setElementValue(element, oldId, fieldConfig);
			return;
		}
		element.dataset.initialValue = newId;
		element.title = newId;
		// 发送 renameId 消息
		vscode.postMessage({
			type: 'renameId',
			payload: { oldId, newId }
		});
		// 更新选中单元格的状态
		if (selectedCell && selectedCell.element === element) {
			selectedCell.value = newId;
		}
		return;
	}

	const previousFormula = element.dataset.formulaValue ?? '';
	const isFormula = trimmedValue.startsWith('=');
	if (isFormula) {
		if (previousFormula === trimmedValue) {
			return;
		}
		if (!Number.isFinite(rowIndex) || rowIndex === undefined || rowIndex < 0) {
			console.warn('[kv-editor] 忽略无法定位行的公式写入', { column: columnKey, id });
			return;
		}
		element.dataset.formulaValue = trimmedValue;
		setFormulaDefinition(columnKey, id, rowIndex, trimmedValue);
		updatePayloadFormulasSnapshot();
		recalculateFormulas({ emitUpdates: true });
		refreshFormulaResultsForTable();
		postSaveFormulaMessage({ column: columnKey, rowId: id, rowIndex, formula: trimmedValue });
		return;
	}
	const hadFormula = Boolean(previousFormula);
	if (hadFormula) {
		if (Number.isFinite(rowIndex) && rowIndex !== undefined && rowIndex >= 0) {
			removeFormulaDefinition(columnKey, id, rowIndex);
		}
		delete element.dataset.formulaValue;
		updatePayloadFormulasSnapshot();
		postSaveFormulaMessage({ column: columnKey, rowId: id, rowIndex, formula: '' });
	}
	const previous = element.dataset.initialValue ?? '';
	if (previous === currentValue) {
		return;
	}
	element.dataset.initialValue = currentValue;
	element.title = currentValue;
	if (Number.isFinite(rowIndex) && rowIndex !== undefined && rowIndex >= 0) {
		updateCachedRowValue(rowIndex, columnKey, currentValue);
	}
	if (id) {
		vscode.postMessage({
			type: 'edit',
			payload: { id, key: columnKey, value: currentValue }
		});
	}
	if (selectedCell && selectedCell.element === element) {
		selectedCell.value = currentValue;
		selectedCell.formula = undefined;
		selectedCell.formulaError = undefined;
		if (formulaValueInput) {
			formulaValueInput.value = currentValue;
		}
	}
	recalculateFormulas({ emitUpdates: true });
	refreshFormulaResultsForTable();
}

// 获取多选项的显示文案
function getOptionLabel(fieldConfig, value) {
	const option = fieldConfig?.options?.find((option) => option.value === value);
	if (!option) return value;
	// 根据本地化模式调整显示：localedMode 为 true 则显示 label，否则显示 value（并在需要时显示 label 作为辅文）
	if (typeof localizedMode !== 'undefined' && localizedMode) {
		return option.label || option.value;
	}
	// 非本地化模式时优先显示原文
	return option.value;
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
		// 适配本地化显示：当 localizedMode 为 false 时，在必要时显示 "value (label)"
		const option = fieldConfig?.options?.find((opt) => opt.value === value);
		if (localizedMode) {
			tag.textContent = option?.label || option?.value || value;
		} else {
			if (option && option.label && option.label !== option.value) {
				tag.textContent = `${option.value} (${option.label})`;
			} else {
				tag.textContent = option?.value || value;
			}
		}
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

		// 根据本地化模式决定显示内容：
		// localizedMode === true -> 显示 label/description 为主，原文为辅
		// localizedMode === false -> 显示 value 为主，label 为辅（如果存在）
		let primaryText;
		let detailText;
		if (localizedMode) {
			primaryText = option.label || option.value;
			// 优先显示 description 作为细节，否则显示原文（当 label 与 value 不同时）
			detailText = option.description || (option.label && option.label !== option.value ? option.value : undefined);
		} else {
			primaryText = option.value;
			detailText = (option.label && option.label !== option.value) ? option.label : (option.description || undefined);
		}

		const labelEl = document.createElement('div');
		labelEl.className = 'kv-quickpick-label';
		labelEl.textContent = primaryText;
		textWrapper.appendChild(labelEl);
		if (detailText) {
			const detailEl = document.createElement('div');
			detailEl.className = 'kv-quickpick-detail';
			detailEl.textContent = detailText;
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
	if (column === ROW_NUMBER_COLUMN_KEY) {
		return ROW_NUMBER_MIN_WIDTH;
	}
	if (column === 'AbilityValues') {
		return Math.max(COLUMN_MIN_WIDTH, 160);
	}
	return COLUMN_MIN_WIDTH;
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
	const estimated = column === 'AbilityValues'
		? Math.max(COLUMN_MIN_WIDTH, 220)
		: Math.max(COLUMN_MIN_WIDTH, labelLength * 12);
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
	// 表格宽度只根据列的总宽度设置，不强制撑满容器
	table.style.minWidth = `${totalWidth}px`;
	table.style.width = `${totalWidth}px`;
}

function resetColumnState() {
	for (const key of Object.keys(columnWidths)) {
		delete columnWidths[key];
	}
	for (const key of Object.keys(originalColumnWidths)) {
		delete originalColumnWidths[key];
	}
	modifiedColumns.clear();
	savedColumnWidths.clear();
}

function cancelColumnWidthSave() {
	if (!columnWidthSaveHandle) {
		return;
	}
	clearTimeout(columnWidthSaveHandle);
	columnWidthSaveHandle = null;
}

function markColumnWidthChange(column, width) {
	if (column === ROW_NUMBER_COLUMN_KEY) {
		return;
	}
	const normalized = Math.max(getMinColumnWidth(column), Math.round(width));
	const baseline = originalColumnWidths[column];
	if (baseline === undefined) {
		originalColumnWidths[column] = normalized;
		modifiedColumns.delete(column);
		return;
	}
	if (Math.round(baseline) === normalized) {
		modifiedColumns.delete(column);
	} else {
		modifiedColumns.add(column);
	}
	if (!modifiedColumns.size) {
		cancelColumnWidthSave();
	}
}

function scheduleColumnWidthSave() {
	if (!latestPayload || !modifiedColumns.size) {
		return;
	}
	if (columnWidthSaveHandle) {
		clearTimeout(columnWidthSaveHandle);
	}
	columnWidthSaveHandle = setTimeout(() => {
		columnWidthSaveHandle = null;
		const widthsPayload = {};
		const columnsToRemoveFromSaved = new Set();

		// 处理修改过的列
		modifiedColumns.forEach((column) => {
			const width = columnWidths[column];
			if (typeof width !== 'number' || !Number.isFinite(width)) {
				return;
			}
			const normalized = Math.max(getMinColumnWidth(column), Math.round(width));
			const baseline = originalColumnWidths[column];
			if (baseline !== undefined && Math.round(baseline) === normalized) {
				return;
			}
			widthsPayload[column] = normalized;
			// 如果这个列曾经被保存过，现在又被修改了，需要更新保存记录
			savedColumnWidths.add(column);
		});

		// 检查曾经保存过但现在可能需要删除的列
		// 如果一个列曾经被保存，但现在的宽度已经恢复到系统计算的初始值（而不是保存的值），则需要删除
		if (!latestPayload.columns) {
			latestPayload.columns = [];
		}
		savedColumnWidths.forEach((column) => {
			// 如果这个列已经在 widthsPayload 中，说明它被重新修改了，不需要检查删除
			if (widthsPayload[column] !== undefined) {
				return;
			}
			// 检查该列是否仍存在于当前表格中
			if (!latestPayload.columns.includes(column)) {
				// 列已经不存在了，标记为需要从保存记录中删除
				columnsToRemoveFromSaved.add(column);
				return;
			}
			// 获取当前列宽
			const currentWidth = columnWidths[column];
			if (!Number.isFinite(currentWidth)) {
				return;
			}
			// 获取该列的系统默认宽度（不考虑保存的值）
			const headerLabel = column;
			const labelLength = Math.max((headerLabel ?? '').length, 4);
			const systemDefaultWidth = column === 'AbilityValues'
				? Math.max(COLUMN_MIN_WIDTH, 220)
				: Math.max(COLUMN_MIN_WIDTH, labelLength * 12);
			// 如果当前宽度等于系统默认宽度，说明用户已经将列宽恢复到初始状态
			// 此时应该删除配置文件中的保存值
			if (Math.round(currentWidth) === Math.round(systemDefaultWidth)) {
				columnsToRemoveFromSaved.add(column);
			}
		});

		// 从 savedColumnWidths 中移除标记为删除的列
		columnsToRemoveFromSaved.forEach((column) => {
			savedColumnWidths.delete(column);
			// 将这些列的宽度设为 null，后端会识别并删除配置
			widthsPayload[column] = null;
		});

		if (!Object.keys(widthsPayload).length) {
			return;
		}
		vscode.postMessage({
			type: 'saveColumnWidths',
			payload: {
				widths: widthsPayload,
			},
		});
		Object.entries(widthsPayload).forEach(([column, value]) => {
			if (value === null) {
				// 删除该列的记录
				delete originalColumnWidths[column];
			} else {
				originalColumnWidths[column] = value;
			}
			modifiedColumns.delete(column);
		});
	}, COLUMN_WIDTH_SAVE_DEBOUNCE_MS);
}

// 更新指定列的宽度并刷新布局
function updateColumnWidth(column, width) {
	const adjusted = Math.max(getMinColumnWidth(column), width);
	columnWidths[column] = adjusted;
	if (tableSection) {
		const colElement = tableSection.querySelector(`col[data-column="${column}"]`);
		if (colElement) {
			colElement.style.width = `${adjusted}px`;
		}
	}
	refreshTableWidth();
	markColumnWidthChange(column, adjusted);
	scheduleColumnWidthSave();
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
	scheduleColumnWidthSave();
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
	const isAbilityColumn = selectedCellKey.column === 'AbilityValues';
	// id 列现在也可以编辑了
	const editable = selectedCellKey.column !== ROW_NUMBER_COLUMN_KEY && !isAbilityColumn;
	const fieldConfig = columnOptions[selectedCellKey.column];
	const usesDropdown = Boolean(fieldConfig?.options?.length);
	let element = null;
	if (editable) {
		element = usesDropdown ? td.querySelector('select') : td.querySelector('input');
	}
	const value = isAbilityColumn
		? (td.dataset.displayValue ?? td.textContent ?? '')
		: editable
			? readElementValue(element, fieldConfig)
			: (td.textContent ?? '');
	const rowId = td.dataset.rowId ?? '';
	const abilityEntries = isAbilityColumn ? parseAbilityEntriesFromCell(td) : undefined;
	const hasAbilityField = isAbilityColumn ? td.dataset.hasAbilityField === 'true' : false;
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
		value,
		dataType: isAbilityColumn ? 'abilityValues' : 'cell',
		abilityEntries,
		hasAbilityField
	});
}

function parseAbilityEntriesFromCell(td) {
	if (!td) {
		return [];
	}
	const json = td.dataset.abilityEntries;
	if (!json) {
		return [];
	}
	try {
		const parsed = JSON.parse(json);
		return cloneAbilityValuesEntries(parsed);
	} catch (error) {
		console.warn('[kv-editor] failed to parse ability entries from cell', error);
		return [];
	}
}

function populateAbilityValuesCell(td, entries, hasAbilityField) {
	if (!td) {
		return { entries: [], displayValue: '' };
	}
	const sanitizedEntries = cloneAbilityValuesEntries(entries || []);
	td.innerHTML = '';
	td.classList.remove('kv-ability-values-cell-empty');
	td.dataset.hasAbilityField = hasAbilityField ? 'true' : 'false';
	try {
		td.dataset.abilityEntries = JSON.stringify(sanitizedEntries);
	} catch (error) {
		console.warn('[kv-editor] failed to stringify ability entries', error);
		delete td.dataset.abilityEntries;
	}

	// 精简模式：显示为纯文本单行
	if (compactMode) {
		const compactText = sanitizedEntries.map(entry => {
			const parts = [`${entry.key}: ${entry.value}`];
			(entry.modifiers || []).forEach(mod => {
				parts.push(`${mod.key}: ${mod.value}`);
			});
			return parts.join(', ');
		}).join(' | ');

		const compactDiv = document.createElement('div');
		compactDiv.className = 'kv-ability-values-compact';
		compactDiv.textContent = compactText || (hasAbilityField ? '(空)' : '');
		compactDiv.title = compactText;
		td.appendChild(compactDiv);
		return { entries: sanitizedEntries, displayValue: compactText };
	}

	// 详细模式：原有的多行显示逻辑
	const list = document.createElement('div');
	list.className = 'kv-ability-values-list';
	const displayLines = [];
	if (sanitizedEntries.length) {
		sanitizedEntries.forEach((entry) => {
			const block = document.createElement('div');
			block.className = 'kv-ability-values-block';
			const baseRow = document.createElement('div');
			baseRow.className = 'kv-ability-values-entry kv-ability-values-entry-base';
			const baseKey = document.createElement('span');
			baseKey.className = 'kv-ability-values-key';
			baseKey.textContent = entry.key;
			baseKey.title = entry.key;
			const baseValue = document.createElement('span');
			baseValue.className = 'kv-ability-values-value';
			baseValue.textContent = entry.value;
			baseValue.title = entry.value;
			baseRow.appendChild(baseKey);
			baseRow.appendChild(baseValue);
			block.appendChild(baseRow);
			displayLines.push(`${entry.key}: ${entry.value}`);
			(entry.modifiers || []).forEach((modifier) => {
				const modifierRow = document.createElement('div');
				modifierRow.className = 'kv-ability-values-entry kv-ability-values-entry-modifier';
				const modifierKey = document.createElement('span');
				modifierKey.className = 'kv-ability-values-key';
				modifierKey.textContent = modifier.key;
				modifierKey.title = modifier.key;
				const modifierValue = document.createElement('span');
				modifierValue.className = 'kv-ability-values-value';
				modifierValue.textContent = modifier.value;
				modifierValue.title = modifier.value;
				modifierRow.appendChild(modifierKey);
				modifierRow.appendChild(modifierValue);
				block.appendChild(modifierRow);
				displayLines.push(`${modifier.key}: ${modifier.value}`);
			});
			list.appendChild(block);
		});
		td.appendChild(list);
	} else if (hasAbilityField) {
		const placeholder = document.createElement('div');
		placeholder.className = 'kv-ability-values-empty';
		placeholder.textContent = '无条目';
		td.appendChild(placeholder);
	} else {
		td.classList.add('kv-ability-values-cell-empty');
		td.textContent = '—';
	}
	const displayValue = displayLines.length
		? displayLines.join('\n')
		: hasAbilityField
			? '无条目'
			: '—';
	td.dataset.displayValue = displayValue;
	td.title = '双击编辑 AbilityValues';
	return { entries: sanitizedEntries, displayValue };
}

function normalizeAbilityEntriesForPayload(entries) {
	return (entries || []).map((entry) => {
		const trimmedKey = (entry.key || '').trim();
		const trimmedOriginalKey = (entry.originalKey || '').trim() || trimmedKey;
		const normalizedModifiers = (entry.modifiers || [])
			.map((modifier) => ({
				key: (modifier.key || '').trim(),
				value: (modifier.value || '').trim(),
			}))
			.filter((modifier) => modifier.key.length > 0);
		const type = entry.type === 'scalar' && normalizedModifiers.length === 0 ? 'scalar' : 'object';
		return {
			key: trimmedKey,
			originalKey: trimmedOriginalKey,
			value: (entry.value || '').trim(),
			type,
			modifiers: normalizedModifiers,
		};
	}).filter((entry) => entry.key.length > 0);
}

// 渲染主表格结构和单元格控件
function renderTable(columns, rows, columnOptions) {
	if (!tableSection) {
		return;
	}
	// 保存当前滚动位置
	const scrollLeft = tableSection.scrollLeft;
	const scrollTop = tableSection.scrollTop;

	cleanupColumnDragState();
	closeRowContextMenu();
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
		let headerLabel;
		if (column === ROW_NUMBER_COLUMN_KEY) {
			headerLabel = '#';
		} else {
			headerLabel = column;
		}
		columnLabels.set(column, headerLabel);
		const width = getColumnWidth(column, headerLabel);
		if (!(column in originalColumnWidths)) {
			originalColumnWidths[column] = Math.round(width);
		}
		const colElement = document.createElement('col');
		colElement.dataset.column = column;
		colElement.style.width = `${width}px`;
		colgroup.appendChild(colElement);
	}
	table.appendChild(colgroup);
	const thead = document.createElement('thead');
	const headRow = document.createElement('tr');
	// 计算冻结列的累积left值
	let cumulativeLeft = 0;
	const frozenColumnsInOrder = [];
	for (const col of displayColumns) {
		if (frozenColumns.has(col) && col !== ROW_NUMBER_COLUMN_KEY) {
			frozenColumnsInOrder.push(col);
		}
	}

	// 找出最右侧的冻结列
	const lastFrozenColumn = frozenColumnsInOrder.length > 0 ? frozenColumnsInOrder[frozenColumnsInOrder.length - 1] : null;

	for (const column of displayColumns) {
		const th = document.createElement('th');
		const headerLabel = columnLabels.get(column) ?? column;
		const columnIndex = column === ROW_NUMBER_COLUMN_KEY ? -1 : columns.indexOf(column);
		th.dataset.column = column;
		th.dataset.columnIndex = String(columnIndex);
		th.style.width = `${getColumnWidth(column, headerLabel)}px`;
		th.style.minWidth = `${getMinColumnWidth(column)}px`;

		// 应用冻结列样式
		if (frozenColumns.has(column) && column !== ROW_NUMBER_COLUMN_KEY) {
			th.dataset.frozen = 'true';
			// 标记最右侧的冻结列
			if (column === lastFrozenColumn) {
				th.dataset.frozenLast = 'true';
			}
			const frozenIndex = frozenColumnsInOrder.indexOf(column);
			let leftPos = ROW_NUMBER_MIN_WIDTH; // 从行号列宽度开始
			for (let i = 0; i < frozenIndex; i++) {
				const prevCol = frozenColumnsInOrder[i];
				const prevLabel = columnLabels.get(prevCol) ?? prevCol;
				leftPos += getColumnWidth(prevCol, prevLabel);
			}
			th.style.left = `${leftPos}px`;
		}
		if (column === ROW_NUMBER_COLUMN_KEY) {
			th.textContent = '#';
		} else {
			const wrapper = document.createElement('div');
			wrapper.className = 'kv-column-header';
			const letterButton = document.createElement('button');
			letterButton.type = 'button';
			letterButton.className = 'kv-column-letter';
			const letterText = document.createElement('span');
			letterText.className = 'kv-column-letter-text';
			letterText.textContent = columnLetters.get(column) ?? '';
			letterButton.appendChild(letterText);
			const letterIcon = document.createElement('span');
			letterIcon.className = 'codicon codicon-gripper kv-column-letter-icon';
			letterIcon.setAttribute('aria-hidden', 'true');
			letterButton.appendChild(letterIcon);
			if (columnIndex > 0) {
				letterButton.setAttribute('draggable', 'true');
				letterButton.setAttribute('aria-label', `拖动列 ${headerLabel}`);
				letterButton.addEventListener('dragstart', (event) => handleColumnDragStart(event, column, columnIndex, letterButton));
				letterButton.addEventListener('dragend', (event) => handleColumnDragEnd(event, letterButton));
				letterButton.addEventListener('mousedown', (event) => event.stopPropagation());
				letterButton.addEventListener('click', (event) => event.preventDefault());
				th.classList.add('kv-column-draggable');
			} else {
				letterButton.setAttribute('draggable', 'false');
				letterButton.setAttribute('aria-disabled', 'true');
				letterButton.tabIndex = -1;
				letterButton.addEventListener('mousedown', (event) => event.stopPropagation());
				letterButton.addEventListener('click', (event) => event.preventDefault());
			}
			const nameEl = document.createElement('span');
			nameEl.className = 'kv-column-name';

			// 获取列的描述配置
			const columnDesc = columnDescriptions[column];
			const displayLabel = (localizedMode && columnDesc?.label) ? columnDesc.label : headerLabel;
			const displayTooltip = (columnDesc?.description) ? columnDesc.description : headerLabel;

			nameEl.textContent = displayLabel;
			nameEl.title = displayTooltip;

			wrapper.appendChild(letterButton);
			const titleRow = document.createElement('div');
			titleRow.className = 'kv-column-header-title-row';
			titleRow.appendChild(nameEl);
			const columnFieldConfig = columnOptions?.[column];
			const optionsButton = document.createElement('button');
			optionsButton.type = 'button';
			optionsButton.className = 'kv-column-options-button';
			optionsButton.title = `编辑 ${headerLabel} 下拉选项`;
			optionsButton.setAttribute('aria-label', `编辑 ${headerLabel} 下拉选项`);
			optionsButton.innerHTML = '<span class="codicon codicon-fold-down"></span>';
			optionsButton.addEventListener('mousedown', (event) => event.stopPropagation());
			optionsButton.addEventListener('click', (event) => {
				event.preventDefault();
				event.stopPropagation();
				openColumnOptionsEditor({
					column,
					columnName: headerLabel,
					folderType: latestPayload?.folderType ?? 'custom',
					options: cloneColumnOptionEntries(columnFieldConfig?.options ?? []),
					multiple: columnFieldConfig?.multiple ?? false,
					separator: columnFieldConfig?.separator ?? '|',
				});
			});
			titleRow.appendChild(optionsButton);
			wrapper.appendChild(titleRow);
			th.appendChild(wrapper);

			// 为列标题添加右键菜单（在整个 th 上响应，跳过 id 列）
			if (columnIndex > 0) {
				th.addEventListener('contextmenu', (event) => {
					openColumnContextMenu(event, {
						targetElement: th,
						columnKey: column,
						columnIndex,
						columnName: headerLabel
					});
				});
				th.style.cursor = 'context-menu';
			}
		}
		if (columnIndex >= 0) {
			th.addEventListener('dragover', (event) => handleColumnDragOver(event, th, column, columnIndex));
			th.addEventListener('dragleave', (event) => handleColumnDragLeave(event, th));
			th.addEventListener('drop', (event) => handleColumnDrop(event, column));
		}
		const resizer = document.createElement('div');
		resizer.className = 'kv-resizer';
		resizer.addEventListener('mousedown', (event) => startColumnResize(event, column));
		th.appendChild(resizer);
		headRow.appendChild(th);
	}
	thead.appendChild(headRow);
	const tbody = document.createElement('tbody');
	tbody.addEventListener('dragover', (event) => handleRowContainerDragOver(event, tbody));
	tbody.addEventListener('dragleave', (event) => handleRowContainerDragLeave(event, tbody));
	tbody.addEventListener('drop', (event) => handleRowContainerDrop(event, tbody));
	rows.forEach((row, rowIndex) => {
		const tr = document.createElement('tr');
		tr.classList.add('kv-row');
		tr.dataset.rowId = row.id ?? '';
		tr.dataset.rowIndex = String(rowIndex);
		for (const column of displayColumns) {
			const td = document.createElement('td');
			td.dataset.column = column;
			td.dataset.rowId = row.id ?? '';
			td.dataset.rowIndex = String(rowIndex);
			td.style.width = `${getColumnWidth(column, columnLabels.get(column) ?? column)}px`;

			// 应用冻结列样式
			if (frozenColumns.has(column) && column !== ROW_NUMBER_COLUMN_KEY) {
				td.dataset.frozen = 'true';
				// 标记最右侧的冻结列
				if (column === lastFrozenColumn) {
					td.dataset.frozenLast = 'true';
				}
				const frozenIndex = frozenColumnsInOrder.indexOf(column);
				let leftPos = ROW_NUMBER_MIN_WIDTH;
				for (let i = 0; i < frozenIndex; i++) {
					const prevCol = frozenColumnsInOrder[i];
					const prevLabel = columnLabels.get(prevCol) ?? prevCol;
					leftPos += getColumnWidth(prevCol, prevLabel);
				}
				td.style.left = `${leftPos}px`;
			}
			const columnLetter = columnLetters.get(column) ?? column;
			const columnName = columnLabels.get(column) ?? column;
			const fieldConfig = columnOptions?.[column];
			const usesDropdown = Boolean(fieldConfig?.options?.length);
			if (column === ROW_NUMBER_COLUMN_KEY) {
				td.classList.add('kv-row-index');
				td.dataset.draggable = row.id ? 'true' : 'false';
				if (row.id) {
					const dragBtn = document.createElement('button');
					dragBtn.type = 'button';
					dragBtn.className = 'kv-row-drag-btn';
					dragBtn.setAttribute('aria-label', '拖动调整顺序');
					const icon = document.createElement('span');
					icon.className = 'codicon codicon-gripper';
					dragBtn.appendChild(icon);
					dragBtn.draggable = true;
					dragBtn.addEventListener('dragstart', (event) => handleRowDragStart(event, row.id, rowIndex, rows.length));
					dragBtn.addEventListener('dragend', handleRowDragEnd);
					dragBtn.addEventListener('mousedown', (event) => event.stopPropagation());
					dragBtn.addEventListener('click', (event) => event.preventDefault());
					td.appendChild(dragBtn);
				}
				const indexLabel = document.createElement('span');
				indexLabel.className = 'kv-row-index-label';
				indexLabel.textContent = String(rowIndex + 1);
				td.appendChild(indexLabel);
				td.addEventListener('click', (event) => {
					// 点击行号进行行选择
					event.preventDefault();
					event.stopPropagation();
					toggleRowSelection(rowIndex, event.ctrlKey || event.metaKey, event.shiftKey);
				});
				td.addEventListener('contextmenu', (event) => {
					openRowContextMenu(event, {
						targetElement: td,
						rowIndex,
						rowId: row.id ?? '',
						menuName: 'row-index'
					});
				});
			} else if (column === 'id') {
				td.classList.add('kv-cell-id');
				// 改为可编辑的 input 元素
				const input = document.createElement('input');
				input.type = 'text';
				input.dataset.id = row.id ?? '';
				input.dataset.key = column;
				input.dataset.rowIndex = String(rowIndex);
				const displayValue = getCellDisplayValue(rowIndex, row.id ?? '', column, row.id ?? '');
				const formulaDefinition = getFormulaDefinition(column, row.id ?? '', rowIndex);
				const computedEntry = getComputedFormulaEntry(column, rowIndex);
				setElementValue(input, displayValue, undefined);
				input.dataset.initialValue = input.value ?? '';

				// 添加撤销/重做支持
				setupUndoRedo(input);

				if (formulaDefinition) {
					input.dataset.formulaValue = formulaDefinition.formula;
				} else {
					delete input.dataset.formulaValue;
				}
				input.title = input.value;
				applyFormulaDecorations(td, formulaDefinition, computedEntry);
				td.dataset.displayValue = displayValue;
				td.appendChild(input);
				input.addEventListener('change', () => handleElementChange(input, undefined));
				input.addEventListener('focus', (event) => {
					activeCell = { id: row.id ?? '', key: column };
					const isFormula = typeof input.dataset.formulaValue === 'string' && input.dataset.formulaValue.length > 0;
					if (isFormula) {
						setElementValue(input, input.dataset.formulaValue, undefined);
					}
					setTimeout(() => {
						input.select();
					}, 0);
				});
				input.addEventListener('blur', (event) => {
					const isFormula = typeof input.dataset.formulaValue === 'string' && input.dataset.formulaValue.length > 0;
					if (isFormula) {
						const displayVal = getCellDisplayValue(rowIndex, row.id ?? '', column, input.dataset.initialValue ?? '');
						setElementValue(input, displayVal, undefined);
					}
				});
				input.addEventListener('mousedown', (event) => {
					if (document.activeElement !== input) {
						input.blur();
					}
				});
				td.addEventListener('click', () => {
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
						value: displayValue
					});
					// 点击只选中单元格，不自动进入编辑状态
					// 用户可以通过空格键或双击进入编辑状态
				});
				td.addEventListener('dblclick', () => {
					// 双击进入编辑状态
					input.focus();
					input.select();
				});
			} else {
				const rawValue = row.values?.[column];
				const displayValue = getCellDisplayValue(rowIndex, row.id ?? '', column, rawValue);
				const formulaDefinition = getFormulaDefinition(column, row.id ?? '', rowIndex);
				const computedEntry = getComputedFormulaEntry(column, rowIndex);
				if (column === 'AbilityValues') {
					applyFormulaDecorations(td, undefined, undefined);
					td.classList.add('kv-ability-values-cell');
					td.tabIndex = 0;
					const hasAbilityField = row.values && Object.prototype.hasOwnProperty.call(row.values, column);
					const populated = populateAbilityValuesCell(td, row.abilityValues, hasAbilityField);
					const getAbilityContext = () => {
						const entries = parseAbilityEntriesFromCell(td);
						const hasField = td.dataset.hasAbilityField === 'true';
						const display = td.dataset.displayValue ?? populated.displayValue;
						return { entries, hasField, display };
					};
					const setSelection = () => {
						const abilityContext = getAbilityContext();
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
							value: abilityContext.display,
							dataType: 'abilityValues',
							abilityEntries: abilityContext.entries,
							hasAbilityField: abilityContext.hasField,
						});
					};
					td.addEventListener('click', setSelection);
					td.addEventListener('focus', setSelection);
					td.addEventListener('keydown', (event) => {
						if (event.key === 'Enter' || event.key === ' ') {
							event.preventDefault();
							setSelection();
							if (event.key === 'Enter' && !event.shiftKey) {
								const context = getAbilityContext();
								openAbilityValuesEditor({
									rowId: row.id ?? '',
									column,
									columnName,
									entries: context.entries,
								});
							}
						}
					});
					td.addEventListener('dblclick', () => {
						const context = getAbilityContext();
						openAbilityValuesEditor({
							rowId: row.id ?? '',
							column,
							columnName,
							entries: context.entries,
						});
					});
				} else if (usesDropdown) {
					const select = document.createElement('select');
					select.dataset.id = row.id ?? '';
					select.dataset.key = column;
					select.dataset.rowIndex = String(rowIndex);
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
					setElementValue(select, displayValue, fieldConfig);
					const initialValue = readElementValue(select, fieldConfig);
					select.dataset.initialValue = initialValue;
					if (formulaDefinition) {
						select.dataset.formulaValue = formulaDefinition.formula;
					} else {
						delete select.dataset.formulaValue;
					}
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
					applyFormulaDecorations(td, formulaDefinition, computedEntry);
					td.dataset.displayValue = readElementValue(select, fieldConfig);
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
					input.dataset.rowIndex = String(rowIndex);
					setElementValue(input, displayValue, undefined);
					input.dataset.initialValue = input.value ?? '';

					// 添加撤销/重做支持
					setupUndoRedo(input);

					if (formulaDefinition) {
						input.dataset.formulaValue = formulaDefinition.formula;
					} else {
						delete input.dataset.formulaValue;
					}
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
					// AbilityTextureName 列始终显示图标选择按钮（即使没有有效的图标预览）
					if (column === 'AbilityTextureName') {
						const wrapper = ensureInlineWrapper();
						const preview = document.createElement('div');
						preview.className = 'kv-cell-preview kv-cell-preview-button';
						preview.tabIndex = 0;

						if (previewInfo && previewInfo.uri) {
							// 有有效的图标预览
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
						} else {
							// 没有有效的图标预览，显示占位图标
							preview.classList.add('kv-cell-preview-placeholder');
							const icon = document.createElement('span');
							icon.className = 'codicon codicon-file-media';
							icon.title = '选择图标';
							preview.appendChild(icon);
						}

						const openMenu = (event) => {
							event.preventDefault();
							event.stopPropagation();
							openTextureMenu({
								input,
								folderType: latestPayload?.folderType ?? 'custom',
								currentValue: input.value ?? '',
								preferredKind: previewInfo?.kind ?? 'spell',
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
					applyFormulaDecorations(td, formulaDefinition, computedEntry);
					td.dataset.displayValue = input.value ?? '';
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
						// 如果是公式单元格，focus 时显示公式以便编辑
						const formulaDef = getFormulaDefinition(column, row.id ?? '', rowIndex);
						if (formulaDef && formulaDef.formula) {
							const currentValue = input.value ?? '';
							// 如果当前显示的是计算结果（不是公式），则切换到公式
							if (!currentValue.startsWith('=')) {
								setElementValue(input, formulaDef.formula, undefined);
							}
						}
						updateSelection();
					});
					input.addEventListener('blur', () => {
						activeCell = undefined;
						// 延迟执行以确保 change 事件先处理
						setTimeout(() => {
							// 如果是公式单元格且当前显示的是公式文本（未修改），恢复显示计算结果
							const formulaDef = getFormulaDefinition(column, row.id ?? '', rowIndex);
							if (formulaDef && formulaDef.formula) {
								const currentValue = input.value ?? '';
								// 只有当前值等于公式定义时才恢复（说明用户没有修改）
								if (currentValue.trim() === formulaDef.formula.trim()) {
									const computed = getComputedFormulaEntry(column, rowIndex);
									if (computed && typeof computed.value === 'string') {
										setElementValue(input, computed.value, undefined);
										input.dataset.initialValue = computed.value;
									}
								}
							}
						}, 0);
					});
					input.addEventListener('change', () => {
						handleElementChange(input, undefined);
						if (updateScriptButtonState) {
							updateScriptButtonState();
						}
					});
					input.addEventListener('mousedown', (event) => {
						// 如果 input 已经有焦点（正在编辑），允许浏览器处理点击（更新光标位置）
						if (document.activeElement === input) {
							return;
						}
						// 点击其他单元格时，先让当前焦点元素失焦
						if (document.activeElement instanceof HTMLElement && document.activeElement !== input) {
							document.activeElement.blur();
						}
						// 只在首次点击（获取焦点）时阻止默认行为并更新选中状态
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
						// 点击 td（非 input 区域）时，先让当前焦点元素失焦
						if (document.activeElement instanceof HTMLElement) {
							document.activeElement.blur();
						}
						updateSelection();
					});
					td.addEventListener('dblclick', () => {
						// focus 事件会自动处理公式显示
						input.focus();
						input.select();
					});
				}
			}
			tr.appendChild(td);
		}
		if (row.id) {
			tr.addEventListener('dragenter', (event) => handleRowDragEnter(event, tr));
			tr.addEventListener('dragover', (event) => handleRowDragOver(event, tr));
			tr.addEventListener('dragleave', () => handleRowDragLeave(tr));
			tr.addEventListener('drop', (event) => handleRowDrop(event, tr));
		}
		tbody.appendChild(tr);
	});
	table.appendChild(thead);
	table.appendChild(tbody);
	tableSection.innerHTML = '';
	tableSection.appendChild(table);
	refreshTableWidth();
	updateRowSelectionVisuals(); // 恢复行选择的视觉状态
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

	// 恢复滚动位置
	if (tableSection) {
		tableSection.scrollLeft = scrollLeft;
		tableSection.scrollTop = scrollTop;
	}

}

function cloneAbilityValuesEntries(entries) {
	if (!Array.isArray(entries)) {
		return [];
	}
	return entries.map((entry) => ({
		key: typeof entry?.key === 'string' ? entry.key : '',
		originalKey: typeof entry?.originalKey === 'string' && entry.originalKey.length ? entry.originalKey : (typeof entry?.key === 'string' ? entry.key : ''),
		value: typeof entry?.value === 'string' ? entry.value : '',
		type: entry?.type === 'scalar' ? 'scalar' : 'object',
		initialType: entry?.type === 'scalar' ? 'scalar' : 'object',
		modifiers: Array.isArray(entry?.modifiers)
			? entry.modifiers.map((modifier) => ({
				key: typeof modifier?.key === 'string' ? modifier.key : '',
				value: typeof modifier?.value === 'string' ? modifier.value : '',
			}))
			: [],
	}));
}

function cloneColumnOptionEntries(options) {
	if (!Array.isArray(options)) {
		return [];
	}
	return options.map((option) => {
		const value = typeof option?.value === 'string' ? option.value : '';
		const label = typeof option?.label === 'string' ? option.label : '';
		const description = typeof option?.description === 'string' ? option.description : '';
		const hasFallbackFlag = option && typeof option === 'object' && Object.prototype.hasOwnProperty.call(option, 'labelIsFallback');
		const labelIsFallback = hasFallbackFlag ? option.labelIsFallback === true : false;
		return {
			value,
			label,
			description,
			labelIsFallback,
		};
	});
}

function createNewAbilityValuesEntry(existingEntries) {
	const usedKeys = new Set();
	(existingEntries || []).forEach((entry) => {
		if (entry && typeof entry.key === 'string') {
			usedKeys.add(entry.key.trim());
		}
	});
	let counter = (existingEntries?.length ?? 0) + 1;
	let candidate = '';
	do {
		candidate = `NewValue${counter}`;
		counter += 1;
	} while (usedKeys.has(candidate));
	return {
		key: candidate,
		originalKey: candidate,
		value: '',
		type: 'object',
		initialType: 'object',
		modifiers: [],
	};
}

function resetAbilityValuesEditorError() {
	if (!abilityValuesEditorState || !abilityValuesEditorState.errorEl) {
		return;
	}
	abilityValuesEditorState.errorEl.textContent = '';
	abilityValuesEditorState.errorEl.hidden = true;
}

function closeAbilityValuesEditor() {
	if (!abilityValuesEditorState) {
		return;
	}
	closeAutofillPopup();
	const { overlay, keyHandler } = abilityValuesEditorState;
	if (overlay && overlay.parentElement) {
		overlay.parentElement.removeChild(overlay);
	}
	if (keyHandler) {
		document.removeEventListener('keydown', keyHandler, true);
	}
	document.body.classList.remove('kv-ability-editor-open');
	abilityValuesEditorState = null;
}

function closeRowContextMenu() {
	if (!rowContextMenuState) {
		return;
	}
	const { menu, outsideHandler, keyHandler, cleanupHandler } = rowContextMenuState;
	if (menu && menu.parentElement) {
		menu.parentElement.removeChild(menu);
	}
	if (outsideHandler) {
		document.removeEventListener('mousedown', outsideHandler, true);
		document.removeEventListener('contextmenu', outsideHandler, true);
	}
	if (keyHandler) {
		document.removeEventListener('keydown', keyHandler, true);
	}
	if (cleanupHandler) {
		document.removeEventListener('scroll', cleanupHandler, true);
		window.removeEventListener('resize', cleanupHandler);
		window.removeEventListener('blur', cleanupHandler);
	}
	rowContextMenuState = null;
}

function closeColumnContextMenu() {
	if (!columnContextMenuState) {
		return;
	}
	const { menu, outsideHandler, keyHandler, cleanupHandler } = columnContextMenuState;
	if (menu && menu.parentElement) {
		menu.parentElement.removeChild(menu);
	}
	if (outsideHandler) {
		document.removeEventListener('mousedown', outsideHandler, true);
		document.removeEventListener('contextmenu', outsideHandler, true);
	}
	if (keyHandler) {
		document.removeEventListener('keydown', keyHandler, true);
	}
	if (cleanupHandler) {
		document.removeEventListener('scroll', cleanupHandler, true);
		window.removeEventListener('resize', cleanupHandler);
		window.removeEventListener('blur', cleanupHandler);
	}
	columnContextMenuState = null;
}

function requestColumnInsertion(position, referenceKey, referenceIndex) {
	if (position !== 'before' && position !== 'after') {
		return;
	}
	if (!referenceKey || typeof referenceKey !== 'string') {
		return;
	}
	if (!Number.isFinite(referenceIndex) || referenceIndex < 0) {
		return;
	}

	const dialog = document.createElement('div');
	dialog.className = 'kv-column-insert-dialog-overlay';

	const form = document.createElement('form');
	form.className = 'kv-column-insert-dialog';

	const title = document.createElement('div');
	title.className = 'kv-column-insert-dialog-title';
	title.textContent = position === 'before' ? '向左插入列' : '向右插入列';
	form.appendChild(title);

	const label = document.createElement('label');
	label.textContent = '列名';
	label.className = 'kv-column-insert-dialog-label';

	const input = document.createElement('input');
	input.type = 'text';
	input.className = 'kv-column-insert-dialog-input';
	input.placeholder = '请输入列名';
	input.required = true;

	label.appendChild(input);
	form.appendChild(label);

	const errorEl = document.createElement('div');
	errorEl.className = 'kv-column-insert-dialog-error';
	errorEl.hidden = true;
	form.appendChild(errorEl);

	const actions = document.createElement('div');
	actions.className = 'kv-column-insert-dialog-actions';

	const cancelBtn = document.createElement('button');
	cancelBtn.type = 'button';
	cancelBtn.className = 'kv-button kv-button-secondary';
	cancelBtn.textContent = '取消';
	actions.appendChild(cancelBtn);

	const submitBtn = document.createElement('button');
	submitBtn.type = 'submit';
	submitBtn.className = 'kv-button kv-button-primary';
	submitBtn.textContent = '插入';
	actions.appendChild(submitBtn);

	form.appendChild(actions);
	dialog.appendChild(form);

	const closeDialog = () => {
		if (dialog.parentElement) {
			dialog.parentElement.removeChild(dialog);
		}
	};

	const showError = (message) => {
		errorEl.textContent = message;
		errorEl.hidden = false;
	};

	const clearError = () => {
		errorEl.textContent = '';
		errorEl.hidden = true;
	};

	form.addEventListener('submit', (event) => {
		event.preventDefault();
		const columnName = input.value.trim();
		if (!columnName) {
			showError('列名不能为空');
			return;
		}

		// 检查列名是否已存在
		const existingColumns = latestPayload?.columns || [];
		if (existingColumns.includes(columnName) || columnName === 'id') {
			showError('列名已存在');
			return;
		}

		// 检查列名是否合法（不能包含特殊字符）
		if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(columnName)) {
			showError('列名只能包含字母、数字和下划线，且不能以数字开头');
			return;
		}

		vscode.postMessage({
			type: 'insertColumn',
			payload: {
				referenceKey,
				referenceIndex: Number(referenceIndex),
				position,
				columnName,
			},
		});

		closeDialog();
	});

	cancelBtn.addEventListener('click', closeDialog);

	input.addEventListener('input', clearError);

	const keyHandler = (event) => {
		if (event.key === 'Escape') {
			event.preventDefault();
			closeDialog();
		}
	};

	document.addEventListener('keydown', keyHandler, true);
	dialog.addEventListener('click', (event) => {
		if (event.target === dialog) {
			closeDialog();
		}
	});

	const originalRemove = dialog.remove;
	dialog.remove = function () {
		document.removeEventListener('keydown', keyHandler, true);
		originalRemove.call(this);
	};

	document.body.appendChild(dialog);

	requestAnimationFrame(() => {
		input.focus();
		input.select();
	});
}

function requestColumnDeletion(columnKey) {
	if (!columnKey || typeof columnKey !== 'string') {
		return;
	}

	// id 列不能删除
	if (columnKey === 'id') {
		return;
	}

	const dialog = document.createElement('div');
	dialog.className = 'kv-column-insert-dialog-overlay';

	const form = document.createElement('form');
	form.className = 'kv-column-insert-dialog';

	const title = document.createElement('div');
	title.className = 'kv-column-insert-dialog-title';
	title.textContent = '确认删除列';
	form.appendChild(title);

	const message = document.createElement('div');
	message.className = 'kv-column-delete-message';
	message.textContent = `确定要删除列 "${columnKey}" 吗？此操作不可恢复。`;
	form.appendChild(message);

	const actions = document.createElement('div');
	actions.className = 'kv-column-insert-dialog-actions';

	const cancelBtn = document.createElement('button');
	cancelBtn.type = 'button';
	cancelBtn.className = 'kv-button kv-button-secondary';
	cancelBtn.textContent = '取消';
	actions.appendChild(cancelBtn);

	const submitBtn = document.createElement('button');
	submitBtn.type = 'submit';
	submitBtn.className = 'kv-button kv-button-primary kv-button-danger';
	submitBtn.textContent = '删除';
	actions.appendChild(submitBtn);

	form.appendChild(actions);
	dialog.appendChild(form);

	const closeDialog = () => {
		if (dialog.parentElement) {
			dialog.parentElement.removeChild(dialog);
		}
	};

	form.addEventListener('submit', (event) => {
		event.preventDefault();

		vscode.postMessage({
			type: 'deleteColumn',
			payload: {
				columnKey,
			},
		});

		closeDialog();
	});

	cancelBtn.addEventListener('click', closeDialog);

	const keyHandler = (event) => {
		if (event.key === 'Escape') {
			event.preventDefault();
			closeDialog();
		}
	};

	document.addEventListener('keydown', keyHandler, true);
	dialog.addEventListener('click', (event) => {
		if (event.target === dialog) {
			closeDialog();
		}
	});

	const originalRemove = dialog.remove;
	dialog.remove = function () {
		document.removeEventListener('keydown', keyHandler, true);
		originalRemove.call(this);
	};

	document.body.appendChild(dialog);
	requestAnimationFrame(() => {
		submitBtn.focus();
	});
}

function requestColumnDescription(columnKey, columnName) {
	if (!columnKey || typeof columnKey !== 'string') {
		return;
	}

	const currentDesc = columnDescriptions[columnKey] || {};

	const dialog = document.createElement('div');
	dialog.className = 'kv-column-insert-dialog-overlay';

	const form = document.createElement('form');
	form.className = 'kv-column-insert-dialog';

	const title = document.createElement('div');
	title.className = 'kv-column-insert-dialog-title';
	title.textContent = `为列 "${columnName}" 添加描述`;
	form.appendChild(title);

	// 标签输入
	const labelWrapper = document.createElement('label');
	labelWrapper.textContent = '显示标签';
	labelWrapper.className = 'kv-column-insert-dialog-label';

	const labelInput = document.createElement('input');
	labelInput.type = 'text';
	labelInput.className = 'kv-column-insert-dialog-input';
	labelInput.placeholder = '本地化显示名称（可选）';
	labelInput.value = currentDesc.label || '';

	labelWrapper.appendChild(labelInput);
	form.appendChild(labelWrapper);

	// 描述输入
	const descWrapper = document.createElement('label');
	descWrapper.textContent = 'Tooltip 描述';
	descWrapper.className = 'kv-column-insert-dialog-label';

	const descInput = document.createElement('textarea');
	descInput.className = 'kv-column-insert-dialog-input kv-column-insert-dialog-textarea';
	descInput.placeholder = '鼠标悬停时显示的描述（可选）';
	descInput.value = currentDesc.description || '';
	descInput.rows = 3;

	descWrapper.appendChild(descInput);
	form.appendChild(descWrapper);

	// 应用范围（默认：仅在当前文件生效）
	const scopeWrapper = document.createElement('label');
	scopeWrapper.className = 'kv-column-insert-dialog-label kv-checkbox-wrapper';
	const scopeCheckbox = document.createElement('input');
	scopeCheckbox.type = 'checkbox';
	scopeCheckbox.className = 'kv-checkbox-input';
	scopeCheckbox.checked = true; // 默认仅在当前文件生效
	scopeWrapper.appendChild(scopeCheckbox);
	const checkIndicator = document.createElement('span');
	checkIndicator.className = 'kv-checkbox-indicator codicon codicon-check';
	scopeWrapper.appendChild(checkIndicator);
	const scopeText = document.createElement('span');
	scopeText.className = 'kv-checkbox-label';
	scopeText.textContent = '仅在当前文件生效';
	scopeWrapper.appendChild(scopeText);
	form.appendChild(scopeWrapper);

	const actions = document.createElement('div');
	actions.className = 'kv-column-insert-dialog-actions';

	const cancelBtn = document.createElement('button');
	cancelBtn.type = 'button';
	cancelBtn.className = 'kv-button kv-button-secondary';
	cancelBtn.textContent = '取消';
	actions.appendChild(cancelBtn);

	const submitBtn = document.createElement('button');
	submitBtn.type = 'submit';
	submitBtn.className = 'kv-button kv-button-primary';
	submitBtn.textContent = '保存';
	actions.appendChild(submitBtn);

	form.appendChild(actions);
	dialog.appendChild(form);

	const closeDialog = () => {
		if (dialog.parentElement) {
			dialog.parentElement.removeChild(dialog);
		}
	};

	form.addEventListener('submit', (event) => {
		event.preventDefault();

		const label = labelInput.value.trim();
		const description = descInput.value.trim();

		// 如果都为空，删除描述
		if (!label && !description) {
			delete columnDescriptions[columnKey];
		} else {
			columnDescriptions[columnKey] = {
				label: label || undefined,
				description: description || undefined
			};
		}

		// 保存到后端（scope: 'file' 或 'global'）并在对话框内显示保存结果
		submitBtn.disabled = true;
		vscode.postMessage({
			type: 'saveColumnDescription',
			payload: {
				columnKey,
				label: label || undefined,
				description: description || undefined,
				scope: scopeCheckbox.checked ? 'file' : 'global'
			}
		});

		// 显示保存提示
		const statusEl = document.createElement('div');
		statusEl.className = 'kv-column-save-status';
		statusEl.textContent = scopeCheckbox.checked ? '已保存到当前文件' : '已保存到工作区默认配置';
		statusEl.style.marginTop = '8px';
		statusEl.style.color = '#3c763d';
		actions.appendChild(statusEl);

		// 立即局部刷新表格（payload 最终会由扩展端返回并触发完整刷新）
		if (latestPayload) {
			renderTable(latestPayload.columns, latestPayload.rows, columnOptionConfig);
		}

		// 0.9s 后关闭对话框
		setTimeout(() => {
			closeDialog();
		}, 900);
	});

	cancelBtn.addEventListener('click', closeDialog);

	const keyHandler = (event) => {
		if (event.key === 'Escape') {
			event.preventDefault();
			closeDialog();
		}
	};

	document.addEventListener('keydown', keyHandler, true);
	dialog.addEventListener('click', (event) => {
		if (event.target === dialog) {
			closeDialog();
		}
	});

	const originalRemove = dialog.remove;
	dialog.remove = function () {
		document.removeEventListener('keydown', keyHandler, true);
		originalRemove.call(this);
	};

	document.body.appendChild(dialog);
	requestAnimationFrame(() => {
		labelInput.focus();
		labelInput.select();
	});
}

function openColumnContextMenu(invocationEvent, context) {
	const resolvedContext = context ?? {};
	if (invocationEvent) {
		invocationEvent.preventDefault();
		invocationEvent.stopPropagation();
	}

	const { columnKey, columnIndex } = resolvedContext;
	if (!columnKey || typeof columnKey !== 'string') {
		return;
	}
	if (!Number.isFinite(columnIndex) || columnIndex < 0) {
		return;
	}

	// 不允许在行号列上右键
	if (columnKey === ROW_NUMBER_COLUMN_KEY) {
		return;
	}

	closeColumnContextMenu();
	closeRowContextMenu();
	closeMultiSelectDropdown();
	closeAbilityValuesEditor();

	const menu = document.createElement('div');
	menu.className = 'kv-column-context-menu';
	menu.setAttribute('role', 'menu');

	// id 列只显示冻结选项
	if (columnKey === 'id') {
		// 添加冻结/取消冻结选项
		const isFrozen = frozenColumns.has(columnKey);
		const freezeButton = document.createElement('button');
		freezeButton.type = 'button';
		freezeButton.className = 'kv-column-context-menu-item';
		freezeButton.textContent = isFrozen ? '取消冻结列' : '冻结列';
		freezeButton.addEventListener('click', () => {
			let frozenColumnKey = null;
			if (isFrozen) {
				// 取消冻结：清空所有冻结列
				frozenColumns.clear();
			} else {
				// 冻结：只冻结id列
				frozenColumns.clear();
				frozenColumns.add('id');
				frozenColumnKey = 'id';
			}
			// 保存冻结状态（只保存最右侧列的key）
			vscode.postMessage({
				type: 'saveFrozenColumns',
				payload: { frozenColumns: frozenColumnKey }
			});
			// 重新渲染表格以应用冻结效果
			if (latestPayload) {
				renderTable(latestPayload.columns, latestPayload.rows, columnOptionConfig);
			}
			closeColumnContextMenu();
		});
		menu.appendChild(freezeButton);
	} else {
		// 其他列显示完整菜单
		const options = [
			{ label: '向左插入列', position: 'before' },
			{ label: '向右插入列', position: 'after' }
		];

		options.forEach((option) => {
			const button = document.createElement('button');
			button.type = 'button';
			button.className = 'kv-column-context-menu-item';
			button.textContent = option.label;
			button.addEventListener('click', () => {
				requestColumnInsertion(option.position, columnKey, columnIndex);
				closeColumnContextMenu();
			});
			menu.appendChild(button);
		});

		// 添加分隔线
		const separator1 = document.createElement('div');
		separator1.className = 'kv-context-menu-separator';
		menu.appendChild(separator1);

		// 添加冻结/取消冻结选项
		const isFrozen = frozenColumns.has(columnKey);
		const freezeButton = document.createElement('button');
		freezeButton.type = 'button';
		freezeButton.className = 'kv-column-context-menu-item';
		freezeButton.textContent = isFrozen ? '取消冻结列' : '冻结列';
		freezeButton.addEventListener('click', () => {
			let frozenColumnKey = null;
			if (isFrozen) {
				// 取消冻结：清空所有冻结列
				frozenColumns.clear();
			} else {
				// 冻结：清空现有冻结列，然后冻结该列及其左侧所有列（包括id列）
				frozenColumns.clear();
				if (latestPayload && latestPayload.columns) {
					const allColumns = latestPayload.columns;
					const targetIndex = allColumns.indexOf(columnKey);
					if (targetIndex >= 0) {
						for (let i = 0; i <= targetIndex; i++) {
							frozenColumns.add(allColumns[i]);
						}
						// 只保存最右侧冻结列的key
						frozenColumnKey = columnKey;
					}
				}
			}
			// 保存冻结状态（只保存最右侧列的key）
			vscode.postMessage({
				type: 'saveFrozenColumns',
				payload: { frozenColumns: frozenColumnKey }
			});
			// 重新渲染表格以应用冻结效果
			if (latestPayload) {
				renderTable(latestPayload.columns, latestPayload.rows, columnOptionConfig);
			}
			closeColumnContextMenu();
		});
		menu.appendChild(freezeButton);

		const separator2 = document.createElement('div');
		separator2.className = 'kv-context-menu-separator';
		menu.appendChild(separator2);

		// 添加描述按钮
		const descButton = document.createElement('button');
		descButton.type = 'button';
		descButton.className = 'kv-column-context-menu-item';
		descButton.textContent = '添加描述';
		descButton.addEventListener('click', () => {
			requestColumnDescription(columnKey, resolvedContext.columnName || columnKey);
			closeColumnContextMenu();
		});
		menu.appendChild(descButton);

		// 添加删除列选项
		const separator3 = document.createElement('div');
		separator3.className = 'kv-context-menu-separator';
		menu.appendChild(separator3);

		const deleteButton = document.createElement('button');
		deleteButton.type = 'button';
		deleteButton.className = 'kv-column-context-menu-item kv-context-menu-item-danger';
		deleteButton.textContent = '删除列';
		deleteButton.addEventListener('click', () => {
			requestColumnDeletion(columnKey);
			closeColumnContextMenu();
		});
		menu.appendChild(deleteButton);
	}

	menu.addEventListener('contextmenu', (event) => event.preventDefault());
	document.body.appendChild(menu);

	const anchorElement = resolvedContext?.targetElement instanceof HTMLElement ? resolvedContext.targetElement : null;
	const anchorRect = anchorElement ? anchorElement.getBoundingClientRect() : null;
	const pointerX = invocationEvent?.clientX ?? (anchorRect ? anchorRect.left + (anchorRect.width / 2) : window.innerWidth / 2);
	const pointerY = invocationEvent?.clientY ?? (anchorRect ? anchorRect.top + (anchorRect.height / 2) : window.innerHeight / 2);

	const rect = menu.getBoundingClientRect();
	const margin = 8;
	let left = pointerX;
	let top = pointerY;

	if (left + rect.width > window.innerWidth - margin) {
		left = Math.max(margin, window.innerWidth - rect.width - margin);
	}
	if (top + rect.height > window.innerHeight - margin) {
		top = Math.max(margin, window.innerHeight - rect.height - margin);
	}
	left = Math.max(margin, left);
	top = Math.max(margin, top);

	menu.style.left = `${left}px`;
	menu.style.top = `${top}px`;

	const outsideHandler = (event) => {
		if (!menu.contains(event.target)) {
			closeColumnContextMenu();
		}
	};

	const keyHandler = (event) => {
		if (event.key === 'Escape') {
			event.preventDefault();
			closeColumnContextMenu();
		}
	};

	const cleanupHandler = () => closeColumnContextMenu();

	document.addEventListener('mousedown', outsideHandler, true);
	document.addEventListener('contextmenu', outsideHandler, true);
	document.addEventListener('keydown', keyHandler, true);
	document.addEventListener('scroll', cleanupHandler, true);
	window.addEventListener('resize', cleanupHandler);
	window.addEventListener('blur', cleanupHandler);

	columnContextMenuState = {
		menu,
		outsideHandler,
		keyHandler,
		cleanupHandler
	};
}

function requestRowInsertion(position, rowId, rowIndex) {
	if (position !== 'before' && position !== 'after') {
		return;
	}
	if (!Number.isFinite(rowIndex)) {
		return;
	}
	const normalizedRowId = typeof rowId === 'string' && rowId.length ? rowId : undefined;
	vscode.postMessage({
		type: 'insertRow',
		payload: {
			referenceId: normalizedRowId,
			referenceIndex: Number(rowIndex),
			position,
		},
	});
}

function requestRowDeletion(rowId, rowIndex) {
	if (!Number.isFinite(rowIndex)) {
		return;
	}
	const normalizedRowId = typeof rowId === 'string' && rowId.length ? rowId : undefined;

	if (!normalizedRowId) {
		return;
	}

	const dialog = document.createElement('div');
	dialog.className = 'kv-column-insert-dialog-overlay';

	const form = document.createElement('form');
	form.className = 'kv-column-insert-dialog';

	const title = document.createElement('div');
	title.className = 'kv-column-insert-dialog-title';
	title.textContent = '确认删除行';
	form.appendChild(title);

	const message = document.createElement('div');
	message.className = 'kv-column-delete-message';
	message.textContent = `确定要删除行 "${normalizedRowId}" 吗？此操作不可恢复。`;
	form.appendChild(message);

	const actions = document.createElement('div');
	actions.className = 'kv-column-insert-dialog-actions';

	const cancelBtn = document.createElement('button');
	cancelBtn.type = 'button';
	cancelBtn.className = 'kv-button kv-button-secondary';
	cancelBtn.textContent = '取消';
	actions.appendChild(cancelBtn);

	const submitBtn = document.createElement('button');
	submitBtn.type = 'submit';
	submitBtn.className = 'kv-button kv-button-primary kv-button-danger';
	submitBtn.textContent = '删除';
	actions.appendChild(submitBtn);

	form.appendChild(actions);
	dialog.appendChild(form);

	const closeDialog = () => {
		if (dialog.parentElement) {
			dialog.parentElement.removeChild(dialog);
		}
	};

	form.addEventListener('submit', (event) => {
		event.preventDefault();

		vscode.postMessage({
			type: 'deleteRow',
			payload: {
				rowId: normalizedRowId,
				rowIndex: Number(rowIndex),
			},
		});

		closeDialog();
	});

	cancelBtn.addEventListener('click', closeDialog);

	const keyHandler = (event) => {
		if (event.key === 'Escape') {
			event.preventDefault();
			closeDialog();
		}
	};

	document.addEventListener('keydown', keyHandler, true);
	dialog.addEventListener('click', (event) => {
		if (event.target === dialog) {
			closeDialog();
		}
	});

	const originalRemove = dialog.remove;
	dialog.remove = function () {
		document.removeEventListener('keydown', keyHandler, true);
		originalRemove.call(this);
	};

	document.body.appendChild(dialog);
	requestAnimationFrame(() => {
		submitBtn.focus();
	});
}

function openRowContextMenu(invocationEvent, context) {
	const resolvedContext = context ?? {};
	if (invocationEvent) {
		invocationEvent.preventDefault();
		invocationEvent.stopPropagation();
	}
	const { rowIndex } = resolvedContext;
	if (!Number.isFinite(rowIndex)) {
		return;
	}
	const normalizedIndex = Number(rowIndex);
	const rowId = typeof resolvedContext.rowId === 'string' ? resolvedContext.rowId : '';
	closeRowContextMenu();
	closeMultiSelectDropdown();
	closeAbilityValuesEditor();
	const menu = document.createElement('div');
	menu.className = 'kv-row-context-menu';
	menu.setAttribute('role', 'menu');
	const options = [
		{ label: '向上插入一行', position: 'before' },
		{ label: '向下插入一行', position: 'after' }
	];
	options.forEach((option) => {
		const button = document.createElement('button');
		button.type = 'button';
		button.className = 'kv-row-context-menu-item';
		button.textContent = option.label;
		button.addEventListener('click', () => {
			requestRowInsertion(option.position, rowId, normalizedIndex);
			closeRowContextMenu();
		});
		menu.appendChild(button);
	});

	// 添加分隔线
	const separator1 = document.createElement('div');
	separator1.className = 'kv-context-menu-separator';
	menu.appendChild(separator1);

	// 添加复制行选项
	const copyButton = document.createElement('button');
	copyButton.type = 'button';
	copyButton.className = 'kv-row-context-menu-item';
	copyButton.textContent = '复制行';
	copyButton.addEventListener('click', () => {
		// 先清除现有选择，选中当前行，然后复制
		selectedRows.clear();
		selectedRows.add(normalizedIndex);
		lastSelectedRowIndex = normalizedIndex;
		updateRowSelectionVisuals();
		copySelectedRows();
		closeRowContextMenu();
	});
	menu.appendChild(copyButton);

	// 添加粘贴行选项
	const pasteButton = document.createElement('button');
	pasteButton.type = 'button';
	pasteButton.className = 'kv-row-context-menu-item';
	pasteButton.textContent = '粘贴行';
	pasteButton.disabled = !copiedRowsData || copiedRowsData.length === 0;
	pasteButton.addEventListener('click', () => {
		if (copiedRowsData && copiedRowsData.length > 0) {
			pasteRows();
		}
		closeRowContextMenu();
	});
	menu.appendChild(pasteButton);

	// 添加分隔线
	const separator2 = document.createElement('div');
	separator2.className = 'kv-context-menu-separator';
	menu.appendChild(separator2);

	// 添加删除行选项
	const deleteButton = document.createElement('button');
	deleteButton.type = 'button';
	deleteButton.className = 'kv-row-context-menu-item kv-context-menu-item-danger';
	deleteButton.textContent = '删除行';
	deleteButton.addEventListener('click', () => {
		requestRowDeletion(rowId, normalizedIndex);
		closeRowContextMenu();
	});
	menu.appendChild(deleteButton);

	menu.addEventListener('contextmenu', (event) => event.preventDefault());
	document.body.appendChild(menu);
	const anchorElement = resolvedContext?.targetElement instanceof HTMLElement ? resolvedContext.targetElement : null;
	const anchorRect = anchorElement ? anchorElement.getBoundingClientRect() : null;
	const pointerX = invocationEvent?.clientX ?? (anchorRect ? anchorRect.left + (anchorRect.width / 2) : window.innerWidth / 2);
	const pointerY = invocationEvent?.clientY ?? (anchorRect ? anchorRect.top + (anchorRect.height / 2) : window.innerHeight / 2);
	const rect = menu.getBoundingClientRect();
	const margin = 8;
	let left = pointerX;
	let top = pointerY;
	if (left + rect.width > window.innerWidth - margin) {
		left = Math.max(margin, window.innerWidth - rect.width - margin);
	}
	if (top + rect.height > window.innerHeight - margin) {
		top = Math.max(margin, window.innerHeight - rect.height - margin);
	}
	left = Math.max(margin, left);
	top = Math.max(margin, top);
	menu.style.left = `${left}px`;
	menu.style.top = `${top}px`;
	const outsideHandler = (event) => {
		if (!menu.contains(event.target)) {
			closeRowContextMenu();
		}
	};
	const keyHandler = (event) => {
		if (event.key === 'Escape') {
			event.preventDefault();
			closeRowContextMenu();
		}
	};
	const cleanupHandler = () => closeRowContextMenu();
	document.addEventListener('mousedown', outsideHandler, true);
	document.addEventListener('contextmenu', outsideHandler, true);
	document.addEventListener('keydown', keyHandler, true);
	document.addEventListener('scroll', cleanupHandler, true);
	window.addEventListener('resize', cleanupHandler);
	window.addEventListener('blur', cleanupHandler);
	rowContextMenuState = {
		menu,
		outsideHandler,
		keyHandler,
		cleanupHandler
	};
}

function closeAutofillPopup() {
	if (!autofillPopupState) {
		return;
	}
	const { element, keyHandler, outsideHandler } = autofillPopupState;
	if (element && element.parentElement) {
		element.remove();
	}
	if (keyHandler) {
		document.removeEventListener('keydown', keyHandler, true);
	}
	if (outsideHandler) {
		document.removeEventListener('mousedown', outsideHandler, true);
	}
	autofillPopupState = null;
}

function openAutofillPopup(context) {
	if (!context || !context.input) {
		return;
	}
	closeAutofillPopup();

	const currentValue = context.input.value || '';
	const baseValue = parseFloat(currentValue) || 0;

	const popup = document.createElement('div');
	popup.className = 'kv-autofill-popup';

	const title = document.createElement('div');
	title.className = 'kv-autofill-popup-title';
	title.textContent = '自动填充';
	popup.appendChild(title);

	// 基础值
	const baseField = document.createElement('div');
	baseField.className = 'kv-autofill-popup-field';
	const baseLabel = document.createElement('label');
	baseLabel.textContent = '基础值';
	const baseInput = document.createElement('input');
	baseInput.type = 'number';
	baseInput.step = 'any';
	baseInput.value = String(baseValue);
	baseField.appendChild(baseLabel);
	baseField.appendChild(baseInput);
	popup.appendChild(baseField);

	// 升级间隔
	const stepField = document.createElement('div');
	stepField.className = 'kv-autofill-popup-field';
	const stepLabel = document.createElement('label');
	stepLabel.textContent = '升级间隔';
	const stepInput = document.createElement('input');
	stepInput.type = 'number';
	stepInput.step = 'any';
	stepInput.value = '1';
	stepField.appendChild(stepLabel);
	stepField.appendChild(stepInput);
	popup.appendChild(stepField);

	// 等级数
	const levelsField = document.createElement('div');
	levelsField.className = 'kv-autofill-popup-field';
	const levelsLabel = document.createElement('label');
	levelsLabel.textContent = '等级数';
	const levelsInput = document.createElement('input');
	levelsInput.type = 'number';
	levelsInput.min = '1';
	levelsInput.value = '4';
	levelsField.appendChild(levelsLabel);
	levelsField.appendChild(levelsInput);
	popup.appendChild(levelsField);

	// 预览
	const preview = document.createElement('div');
	preview.className = 'kv-autofill-popup-preview';
	preview.textContent = '预览: ';
	popup.appendChild(preview);

	// 更新预览
	const updatePreview = () => {
		const base = parseFloat(baseInput.value) || 0;
		const step = parseFloat(stepInput.value) || 0;
		const levels = parseInt(levelsInput.value) || 1;
		const values = [];
		for (let i = 0; i < levels; i++) {
			values.push(base + step * i);
		}
		preview.textContent = '预览: ' + values.join(' ');
	};

	baseInput.addEventListener('input', updatePreview);
	stepInput.addEventListener('input', updatePreview);
	levelsInput.addEventListener('input', updatePreview);
	updatePreview();

	// 按钮
	const actions = document.createElement('div');
	actions.className = 'kv-autofill-popup-actions';

	const cancelButton = document.createElement('button');
	cancelButton.type = 'button';
	cancelButton.className = 'kv-button kv-button-secondary';
	cancelButton.textContent = '取消';
	actions.appendChild(cancelButton);

	const applyButton = document.createElement('button');
	applyButton.type = 'button';
	applyButton.className = 'kv-button kv-button-primary';
	applyButton.textContent = '应用';
	actions.appendChild(applyButton);

	popup.appendChild(actions);

	// 事件处理
	const keyHandler = (event) => {
		if (event.key === 'Escape') {
			event.preventDefault();
			event.stopPropagation();
			closeAutofillPopup();
		}
	};

	const outsideHandler = (event) => {
		if (!popup.contains(event.target)) {
			closeAutofillPopup();
		}
	};

	cancelButton.addEventListener('click', () => closeAutofillPopup());

	applyButton.addEventListener('click', () => {
		const base = parseFloat(baseInput.value) || 0;
		const step = parseFloat(stepInput.value) || 0;
		const levels = parseInt(levelsInput.value) || 1;
		const values = [];
		for (let i = 0; i < levels; i++) {
			values.push(base + step * i);
		}
		context.input.value = values.join(' ');

		// 触发 input 事件以保存撤销历史
		const inputEvent = new Event('input', { bubbles: true });
		context.input.dispatchEvent(inputEvent);

		closeAutofillPopup();
	});

	document.addEventListener('keydown', keyHandler, true);
	document.addEventListener('mousedown', outsideHandler, true);

	document.body.appendChild(popup);

	// 定位弹窗
	const inputRect = context.input.getBoundingClientRect();
	popup.style.top = `${inputRect.bottom + 4}px`;
	popup.style.left = `${inputRect.left}px`;

	autofillPopupState = {
		element: popup,
		keyHandler,
		outsideHandler,
		targetInput: context.input,
	};

	// 聚焦到步长输入框
	requestAnimationFrame(() => stepInput.focus());
}

function openAbilityValuesEditor(context) {
	if (!context || !context.rowId) {
		return;
	}
	closeMultiSelectDropdown();
	closeAbilityValuesEditor();
	const entries = cloneAbilityValuesEntries(context.entries || []);
	const overlay = document.createElement('div');
	overlay.className = 'kv-ability-editor-overlay';
	const dialog = document.createElement('div');
	dialog.className = 'kv-ability-editor';
	overlay.appendChild(dialog);
	const header = document.createElement('div');
	header.className = 'kv-ability-editor-header';
	const title = document.createElement('div');
	title.className = 'kv-ability-editor-title';
	const titleSegments = [];
	if (context.columnName) {
		titleSegments.push(context.columnName);
	}
	if (context.rowId) {
		titleSegments.push(context.rowId);
	}
	title.textContent = titleSegments.join(' · ') || 'AbilityValues';
	header.appendChild(title);
	const closeButton = document.createElement('button');
	closeButton.type = 'button';
	closeButton.className = 'kv-button kv-button-icon kv-ability-editor-close';
	closeButton.title = '关闭';
	closeButton.innerHTML = '<span class="codicon codicon-close"></span>';
	header.appendChild(closeButton);
	dialog.appendChild(header);
	const body = document.createElement('div');
	body.className = 'kv-ability-editor-body';
	const entriesContainer = document.createElement('div');
	entriesContainer.className = 'kv-ability-editor-entries';
	body.appendChild(entriesContainer);
	dialog.appendChild(body);
	const footer = document.createElement('div');
	footer.className = 'kv-ability-editor-footer';
	const footerLeft = document.createElement('div');
	footerLeft.className = 'kv-ability-editor-footer-left';
	const addEntryButton = document.createElement('button');
	addEntryButton.type = 'button';
	addEntryButton.className = 'kv-button kv-button-secondary';
	addEntryButton.dataset.role = 'add-entry';
	addEntryButton.textContent = '新增条目';
	footerLeft.appendChild(addEntryButton);
	footer.appendChild(footerLeft);
	const footerRight = document.createElement('div');
	footerRight.className = 'kv-ability-editor-footer-right';
	const errorEl = document.createElement('div');
	errorEl.className = 'kv-ability-editor-error';
	errorEl.hidden = true;
	footerRight.appendChild(errorEl);
	const cancelButton = document.createElement('button');
	cancelButton.type = 'button';
	cancelButton.className = 'kv-button kv-button-secondary';
	cancelButton.dataset.role = 'cancel';
	cancelButton.textContent = '取消';
	footerRight.appendChild(cancelButton);
	const saveButton = document.createElement('button');
	saveButton.type = 'button';
	saveButton.className = 'kv-button kv-button-primary';
	saveButton.dataset.role = 'apply';
	saveButton.textContent = '保存';
	footerRight.appendChild(saveButton);
	footer.appendChild(footerRight);
	dialog.appendChild(footer);
	const keyHandler = (event) => {
		if (event.key === 'Escape') {
			event.preventDefault();
			event.stopPropagation();
			closeAbilityValuesEditor();
		}
	};
	const handleOverlayClick = (event) => {
		if (event.target === overlay) {
			closeAbilityValuesEditor();
		}
	};
	overlay.addEventListener('click', handleOverlayClick);
	dialog.addEventListener('click', (event) => event.stopPropagation());
	closeButton.addEventListener('click', () => closeAbilityValuesEditor());
	cancelButton.addEventListener('click', () => closeAbilityValuesEditor());
	saveButton.addEventListener('click', () => submitAbilityValuesEditor());
	addEntryButton.addEventListener('click', () => {
		if (!abilityValuesEditorState) {
			return;
		}
		resetAbilityValuesEditorError();
		const nextEntry = createNewAbilityValuesEntry(abilityValuesEditorState.entries);
		abilityValuesEditorState.entries.push(nextEntry);
		renderAbilityValuesEditorEntries();
		focusAbilityValuesEditorInput('entry-key', abilityValuesEditorState.entries.length - 1);
	});
	entriesContainer.addEventListener('input', handleAbilityValuesEditorInput);
	entriesContainer.addEventListener('click', handleAbilityValuesEditorClick);
	document.body.appendChild(overlay);
	document.addEventListener('keydown', keyHandler, true);
	abilityValuesEditorState = {
		overlay,
		dialog,
		entriesContainer,
		errorEl,
		entries,
		rowId: context.rowId,
		column: context.column,
		columnName: context.columnName,
		keyHandler,
	};
	renderAbilityValuesEditorEntries();
	resetAbilityValuesEditorError();
	document.body.classList.add('kv-ability-editor-open');
	if (entries.length) {
		focusAbilityValuesEditorInput('entry-key', 0);
	}
}

function renderAbilityValuesEditorEntries() {
	if (!abilityValuesEditorState) {
		return;
	}
	const { entriesContainer, entries } = abilityValuesEditorState;
	entriesContainer.innerHTML = '';
	if (!entries.length) {
		const empty = document.createElement('div');
		empty.className = 'kv-ability-editor-empty';
		empty.textContent = '暂无 AbilityValues 条目，请添加。';
		entriesContainer.appendChild(empty);
		return;
	}
	entries.forEach((entry, entryIndex) => {
		const entryEl = document.createElement('div');
		entryEl.className = 'kv-ability-editor-entry';
		entryEl.dataset.entryIndex = String(entryIndex);
		const mainRow = document.createElement('div');
		mainRow.className = 'kv-ability-editor-entry-row kv-ability-editor-entry-main-row';
		const keyInput = document.createElement('input');
		keyInput.type = 'text';
		keyInput.className = 'kv-ability-editor-input';
		keyInput.placeholder = '条目键';
		keyInput.dataset.role = 'entry-key';
		keyInput.dataset.entryIndex = String(entryIndex);
		keyInput.value = entry.key;
		mainRow.appendChild(keyInput);
		const valueGroup = document.createElement('div');
		valueGroup.className = 'kv-ability-editor-value-group';
		const valueInput = document.createElement('input');
		valueInput.type = 'text';
		valueInput.className = 'kv-ability-editor-input';
		valueInput.placeholder = '基础值';
		valueInput.dataset.role = 'entry-value';
		valueInput.dataset.entryIndex = String(entryIndex);
		valueInput.value = entry.value;

		// 添加撤销/重做支持
		setupUndoRedo(valueInput);

		valueGroup.appendChild(valueInput);
		const autofillButton = document.createElement('button');
		autofillButton.type = 'button';
		autofillButton.className = 'kv-button kv-button-tertiary kv-ability-editor-autofill-btn';
		autofillButton.title = '自动填充 (基础值 + 升级间隔 × 等级)';
		autofillButton.innerHTML = '<span class="codicon codicon-wand"></span>';
		autofillButton.addEventListener('click', () => {
			openAutofillPopup({ input: valueInput });
		});
		valueGroup.appendChild(autofillButton);
		mainRow.appendChild(valueGroup);
		const removeEntryButton = document.createElement('button');
		removeEntryButton.type = 'button';
		removeEntryButton.className = 'kv-button kv-button-tertiary kv-ability-editor-remove-entry';
		removeEntryButton.dataset.role = 'remove-entry';
		removeEntryButton.dataset.entryIndex = String(entryIndex);
		removeEntryButton.title = '删除条目';
		removeEntryButton.innerHTML = '<span class="codicon codicon-trash"></span>';
		mainRow.appendChild(removeEntryButton);
		entryEl.appendChild(mainRow);
		const modifiersContainer = document.createElement('div');
		modifiersContainer.className = 'kv-ability-editor-modifiers';
		entry.modifiers.forEach((modifier, modifierIndex) => {
			const modifierRow = document.createElement('div');
			modifierRow.className = 'kv-ability-editor-modifier';
			modifierRow.dataset.entryIndex = String(entryIndex);
			modifierRow.dataset.modifierIndex = String(modifierIndex);
			const modifierKeyInput = document.createElement('input');
			modifierKeyInput.type = 'text';
			modifierKeyInput.className = 'kv-ability-editor-input kv-ability-editor-modifier-key';
			modifierKeyInput.placeholder = '修饰键';
			modifierKeyInput.dataset.role = 'modifier-key';
			modifierKeyInput.dataset.entryIndex = String(entryIndex);
			modifierKeyInput.dataset.modifierIndex = String(modifierIndex);
			modifierKeyInput.value = modifier.key;
			modifierRow.appendChild(modifierKeyInput);
			const modifierValueInput = document.createElement('input');
			modifierValueInput.type = 'text';
			modifierValueInput.className = 'kv-ability-editor-input kv-ability-editor-modifier-value';
			modifierValueInput.placeholder = '修饰值';
			modifierValueInput.dataset.role = 'modifier-value';
			modifierValueInput.dataset.entryIndex = String(entryIndex);
			modifierValueInput.dataset.modifierIndex = String(modifierIndex);
			modifierValueInput.value = modifier.value;
			modifierRow.appendChild(modifierValueInput);
			const removeModifierButton = document.createElement('button');
			removeModifierButton.type = 'button';
			removeModifierButton.className = 'kv-button kv-button-tertiary kv-ability-editor-remove-modifier';
			removeModifierButton.dataset.role = 'remove-modifier';
			removeModifierButton.dataset.entryIndex = String(entryIndex);
			removeModifierButton.dataset.modifierIndex = String(modifierIndex);
			removeModifierButton.title = '删除';
			removeModifierButton.innerHTML = '<span class="codicon codicon-trash"></span>';
			modifierRow.appendChild(removeModifierButton);
			modifiersContainer.appendChild(modifierRow);
		});
		entryEl.appendChild(modifiersContainer);
		const addModifierButton = document.createElement('button');
		addModifierButton.type = 'button';
		addModifierButton.className = 'kv-button kv-button-tertiary kv-ability-editor-add-modifier';
		addModifierButton.dataset.role = 'add-modifier';
		addModifierButton.dataset.entryIndex = String(entryIndex);
		addModifierButton.title = '新增修饰';
		addModifierButton.innerHTML = '<span class="codicon codicon-add"></span>';
		entryEl.appendChild(addModifierButton);
		entriesContainer.appendChild(entryEl);
	});
}

function focusAbilityValuesEditorInput(role, entryIndex, modifierIndex) {
	if (!abilityValuesEditorState) {
		return;
	}
	window.requestAnimationFrame(() => {
		if (!abilityValuesEditorState) {
			return;
		}
		let selector = '';
		if (role === 'entry-key') {
			selector = `.kv-ability-editor-input[data-role="entry-key"][data-entry-index="${entryIndex}"]`;
		} else if (role === 'entry-value') {
			selector = `.kv-ability-editor-input[data-role="entry-value"][data-entry-index="${entryIndex}"]`;
		} else if (role === 'modifier-key') {
			selector = `.kv-ability-editor-input[data-role="modifier-key"][data-entry-index="${entryIndex}"][data-modifier-index="${modifierIndex}"]`;
		} else if (role === 'modifier-value') {
			selector = `.kv-ability-editor-input[data-role="modifier-value"][data-entry-index="${entryIndex}"][data-modifier-index="${modifierIndex}"]`;
		}
		if (!selector) {
			return;
		}
		const input = abilityValuesEditorState.entriesContainer.querySelector(selector);
		if (input instanceof HTMLInputElement) {
			input.focus({ preventScroll: false });
			input.select();
		}
	});
}

function handleAbilityValuesEditorInput(event) {
	if (!abilityValuesEditorState) {
		return;
	}
	const target = event.target;
	if (!(target instanceof HTMLInputElement)) {
		return;
	}
	const entryIndex = Number(target.dataset.entryIndex);
	if (!Number.isFinite(entryIndex) || entryIndex < 0 || entryIndex >= abilityValuesEditorState.entries.length) {
		return;
	}
	const role = target.dataset.role;
	const entry = abilityValuesEditorState.entries[entryIndex];
	if (!entry) {
		return;
	}
	resetAbilityValuesEditorError();
	switch (role) {
		case 'entry-key':
			entry.key = target.value;
			break;
		case 'entry-value':
			entry.value = target.value;
			break;
		case 'modifier-key':
		case 'modifier-value': {
			const modifierIndex = Number(target.dataset.modifierIndex);
			if (!Number.isFinite(modifierIndex) || modifierIndex < 0 || modifierIndex >= entry.modifiers.length) {
				return;
			}
			if (role === 'modifier-key') {
				entry.modifiers[modifierIndex].key = target.value;
			} else {
				entry.modifiers[modifierIndex].value = target.value;
			}
			entry.type = 'object';
			break;
		}
		default:
			break;
	}
}

function handleAbilityValuesEditorClick(event) {
	if (!abilityValuesEditorState) {
		return;
	}
	const target = event.target;
	if (!(target instanceof HTMLElement)) {
		return;
	}
	const role = target.dataset.role;
	if (!role) {
		return;
	}
	const entryIndex = Number(target.dataset.entryIndex);
	const entry = Number.isFinite(entryIndex) ? abilityValuesEditorState.entries[entryIndex] : undefined;
	if (role === 'remove-entry') {
		event.preventDefault();
		if (entryIndex >= 0 && entryIndex < abilityValuesEditorState.entries.length) {
			abilityValuesEditorState.entries.splice(entryIndex, 1);
			renderAbilityValuesEditorEntries();
			resetAbilityValuesEditorError();
		}
		return;
	}
	if (role === 'add-modifier' && entry) {
		event.preventDefault();
		const modifier = { key: '', value: '' };
		entry.modifiers.push(modifier);
		entry.type = 'object';
		renderAbilityValuesEditorEntries();
		focusAbilityValuesEditorInput('modifier-key', entryIndex, entry.modifiers.length - 1);
		resetAbilityValuesEditorError();
		return;
	}
	if (role === 'remove-modifier' && entry) {
		event.preventDefault();
		const modifierIndex = Number(target.dataset.modifierIndex);
		if (!Number.isFinite(modifierIndex) || modifierIndex < 0 || modifierIndex >= entry.modifiers.length) {
			return;
		}
		entry.modifiers.splice(modifierIndex, 1);
		if (!entry.modifiers.length && entry.initialType === 'scalar') {
			entry.type = 'scalar';
		}
		renderAbilityValuesEditorEntries();
		resetAbilityValuesEditorError();
	}
}

function validateAbilityValuesEntries(entries) {
	const seenKeys = new Set();
	for (let i = 0; i < entries.length; i += 1) {
		const entry = entries[i];
		const trimmedKey = (entry.key || '').trim();
		if (!trimmedKey) {
			return { valid: false, message: `第 ${i + 1} 个条目的键不能为空。` };
		}
		if (seenKeys.has(trimmedKey)) {
			return { valid: false, message: `条目键 "${trimmedKey}" 重复。` };
		}
		seenKeys.add(trimmedKey);
		for (let j = 0; j < entry.modifiers.length; j += 1) {
			const modifier = entry.modifiers[j];
			const modifierKey = (modifier.key || '').trim();
			if (!modifierKey) {
				return { valid: false, message: `条目 "${trimmedKey}" 的第 ${j + 1} 个修饰键不能为空。` };
			}
		}
	}
	return { valid: true };
}

function submitAbilityValuesEditor() {
	if (!abilityValuesEditorState) {
		return;
	}
	resetAbilityValuesEditorError();
	const { entries, rowId, errorEl } = abilityValuesEditorState;
	if (!rowId) {
		closeAbilityValuesEditor();
		return;
	}
	const validation = validateAbilityValuesEntries(entries);
	if (!validation.valid) {
		if (errorEl) {
			errorEl.textContent = validation.message || '存在未通过校验的内容。';
			errorEl.hidden = false;
		}
		return;
	}
	const payloadEntries = normalizeAbilityEntriesForPayload(entries);
	vscode.postMessage({
		type: 'editAbilityValues',
		payload: {
			id: rowId,
			entries: payloadEntries,
		},
	});
	closeAbilityValuesEditor();
}

function openColumnOptionsEditor(context) {
	if (!context || !context.column) {
		return;
	}
	closeColumnOptionsEditor();
	const overlay = document.createElement('div');
	overlay.className = 'kv-column-options-overlay';
	const dialog = document.createElement('div');
	dialog.className = 'kv-column-options-dialog';
	overlay.appendChild(dialog);
	const header = document.createElement('div');
	header.className = 'kv-column-options-header';
	const title = document.createElement('div');
	title.className = 'kv-column-options-title';
	const titleParts = [];
	if (context.columnName) {
		titleParts.push(context.columnName);
	}
	titleParts.push('下拉选项');
	title.textContent = titleParts.join(' · ');
	header.appendChild(title);
	const closeButton = document.createElement('button');
	closeButton.type = 'button';
	closeButton.className = 'kv-button kv-button-icon kv-column-options-close';
	closeButton.title = '关闭';
	closeButton.innerHTML = '<span class="codicon codicon-close"></span>';
	header.appendChild(closeButton);
	dialog.appendChild(header);
	const body = document.createElement('div');
	body.className = 'kv-column-options-body';
	const listContainer = document.createElement('div');
	listContainer.className = 'kv-column-options-list';
	body.appendChild(listContainer);
	dialog.appendChild(body);
	const footer = document.createElement('div');
	footer.className = 'kv-column-options-footer';
	const footerLeft = document.createElement('div');
	footerLeft.className = 'kv-column-options-footer-left';
	const addButton = document.createElement('button');
	addButton.type = 'button';
	addButton.className = 'kv-button kv-button-secondary';
	addButton.textContent = '新增选项';
	footerLeft.appendChild(addButton);

	// 添加"仅在当前文件生效"复选框（VS Code 风格）
	const scopeCheckboxWrapper = document.createElement('label');
	scopeCheckboxWrapper.className = 'kv-checkbox-wrapper';
	scopeCheckboxWrapper.style.cssText = 'margin-left: 16px;';
	const scopeCheckbox = document.createElement('input');
	scopeCheckbox.type = 'checkbox';
	scopeCheckbox.className = 'kv-checkbox-input';
	scopeCheckbox.checked = true; // 默认勾选
	scopeCheckboxWrapper.appendChild(scopeCheckbox);
	const checkIndicator = document.createElement('span');
	checkIndicator.className = 'kv-checkbox-indicator codicon codicon-check';
	scopeCheckboxWrapper.appendChild(checkIndicator);
	const scopeLabel = document.createElement('span');
	scopeLabel.className = 'kv-checkbox-label';
	scopeLabel.textContent = '仅在当前文件生效';
	scopeCheckboxWrapper.appendChild(scopeLabel);
	footerLeft.appendChild(scopeCheckboxWrapper);

	// 添加"允许多选"复选框
	const multiSelectWrapper = document.createElement('label');
	multiSelectWrapper.className = 'kv-checkbox-wrapper';
	multiSelectWrapper.style.cssText = 'margin-left: 16px;';
	const multiSelectCheckbox = document.createElement('input');
	multiSelectCheckbox.type = 'checkbox';
	multiSelectCheckbox.className = 'kv-checkbox-input';
	multiSelectCheckbox.checked = context.multiple ?? false;
	multiSelectWrapper.appendChild(multiSelectCheckbox);
	const multiSelectIndicator = document.createElement('span');
	multiSelectIndicator.className = 'kv-checkbox-indicator codicon codicon-check';
	multiSelectWrapper.appendChild(multiSelectIndicator);
	const multiSelectLabel = document.createElement('span');
	multiSelectLabel.className = 'kv-checkbox-label';
	multiSelectLabel.textContent = '允许多选';
	multiSelectWrapper.appendChild(multiSelectLabel);
	footerLeft.appendChild(multiSelectWrapper);

	// 添加"分隔符"输入框
	const separatorWrapper = document.createElement('div');
	separatorWrapper.className = 'kv-separator-wrapper';
	separatorWrapper.style.cssText = 'margin-left: 16px; display: inline-flex; align-items: center; gap: 4px;';
	const separatorLabel = document.createElement('span');
	separatorLabel.className = 'kv-separator-label';
	separatorLabel.textContent = '分隔符:';
	separatorLabel.style.cssText = 'font-size: 12px; color: var(--vscode-descriptionForeground);';
	separatorWrapper.appendChild(separatorLabel);
	const separatorInput = document.createElement('input');
	separatorInput.type = 'text';
	separatorInput.className = 'kv-separator-input';
	separatorInput.value = context.separator ?? '|';
	separatorInput.style.cssText = 'width: 40px; padding: 2px 6px; font-size: 12px; text-align: center; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px;';
	separatorInput.maxLength = 3;
	separatorWrapper.appendChild(separatorInput);
	footerLeft.appendChild(separatorWrapper);

	footer.appendChild(footerLeft);
	const footerRight = document.createElement('div');
	footerRight.className = 'kv-column-options-footer-right';
	const errorEl = document.createElement('div');
	errorEl.className = 'kv-column-options-error';
	errorEl.hidden = true;
	footerRight.appendChild(errorEl);
	const cancelButton = document.createElement('button');
	cancelButton.type = 'button';
	cancelButton.className = 'kv-button kv-button-secondary';
	cancelButton.textContent = '取消';
	footerRight.appendChild(cancelButton);
	const saveButton = document.createElement('button');
	saveButton.type = 'button';
	saveButton.className = 'kv-button kv-button-primary';
	saveButton.textContent = '保存';
	footerRight.appendChild(saveButton);
	footer.appendChild(footerRight);
	dialog.appendChild(footer);
	const keyHandler = (event) => {
		if (event.key === 'Escape') {
			event.preventDefault();
			event.stopPropagation();
			closeColumnOptionsEditor();
		}
	};
	const options = cloneColumnOptionEntries(context.options || []);
	const state = {
		overlay,
		dialog,
		listContainer,
		errorEl,
		scopeCheckbox,
		multiSelectCheckbox,
		separatorInput,
		column: context.column,
		columnName: context.columnName || context.column,
		folderType: context.folderType || (latestPayload?.folderType ?? 'custom'),
		options,
		keyHandler,
	};
	listContainer.addEventListener('input', handleColumnOptionsEditorInput);
	listContainer.addEventListener('click', handleColumnOptionsEditorClick);
	overlay.addEventListener('click', (event) => {
		if (event.target === overlay) {
			closeColumnOptionsEditor();
		}
	});
	dialog.addEventListener('click', (event) => event.stopPropagation());
	closeButton.addEventListener('click', () => closeColumnOptionsEditor());
	cancelButton.addEventListener('click', () => closeColumnOptionsEditor());
	saveButton.addEventListener('click', () => submitColumnOptionsEditor());
	addButton.addEventListener('click', () => {
		if (!columnOptionsEditorState) {
			return;
		}
		resetColumnOptionsEditorError();
		columnOptionsEditorState.options.push({ value: '', label: '', description: '', labelIsFallback: true });
		renderColumnOptionsEditorOptions();
		focusColumnOptionsEditorInput(columnOptionsEditorState.options.length - 1, 'value');
	});
	resetColumnOptionsEditorError(state);
	columnOptionsEditorState = state;
	renderColumnOptionsEditorOptions();
	document.body.appendChild(overlay);
	document.addEventListener('keydown', keyHandler, true);
	document.body.classList.add('kv-column-options-editor-open');
	if (options.length) {
		focusColumnOptionsEditorInput(0, 'value');
	}
}

function closeColumnOptionsEditor() {
	if (!columnOptionsEditorState) {
		return;
	}
	const { overlay, listContainer, keyHandler } = columnOptionsEditorState;
	if (listContainer) {
		listContainer.removeEventListener('input', handleColumnOptionsEditorInput);
		listContainer.removeEventListener('click', handleColumnOptionsEditorClick);
	}
	if (overlay?.parentElement) {
		overlay.parentElement.removeChild(overlay);
	}
	if (keyHandler) {
		document.removeEventListener('keydown', keyHandler, true);
	}
	document.body.classList.remove('kv-column-options-editor-open');
	columnOptionsEditorState = null;
}

function resetColumnOptionsEditorError(state) {
	const targetState = state || columnOptionsEditorState;
	if (!targetState?.errorEl) {
		return;
	}
	targetState.errorEl.textContent = '';
	targetState.errorEl.hidden = true;
}

function setColumnOptionsEditorError(message) {
	if (!columnOptionsEditorState?.errorEl) {
		return;
	}
	columnOptionsEditorState.errorEl.textContent = message || '存在未通过校验的内容。';
	columnOptionsEditorState.errorEl.hidden = false;
}

function renderColumnOptionsEditorOptions() {
	if (!columnOptionsEditorState) {
		return;
	}
	const { listContainer, options } = columnOptionsEditorState;
	listContainer.innerHTML = '';
	if (!options.length) {
		const empty = document.createElement('div');
		empty.className = 'kv-column-options-empty';
		empty.textContent = '暂无下拉选项，点击“新增选项”开始添加。';
		listContainer.appendChild(empty);
		return;
	}
	options.forEach((option, index) => {
		const row = document.createElement('div');
		row.className = 'kv-column-options-row';
		row.dataset.index = String(index);
		const valueInput = document.createElement('input');
		valueInput.type = 'text';
		valueInput.className = 'kv-ability-editor-input kv-column-options-input';
		valueInput.placeholder = '选项值';
		valueInput.dataset.role = 'value';
		valueInput.dataset.index = String(index);
		valueInput.value = option.value;
		row.appendChild(valueInput);
		const labelInput = document.createElement('input');
		labelInput.type = 'text';
		labelInput.className = 'kv-ability-editor-input kv-column-options-input';
		labelInput.placeholder = '显示文本（可选）';
		labelInput.dataset.role = 'label';
		labelInput.dataset.index = String(index);
		labelInput.value = option.labelIsFallback ? '' : option.label;
		row.appendChild(labelInput);
		const descriptionInput = document.createElement('input');
		descriptionInput.type = 'text';
		descriptionInput.className = 'kv-ability-editor-input kv-column-options-input';
		descriptionInput.placeholder = '描述（可选）';
		descriptionInput.dataset.role = 'description';
		descriptionInput.dataset.index = String(index);
		descriptionInput.value = option.description;
		row.appendChild(descriptionInput);
		const actions = document.createElement('div');
		actions.className = 'kv-column-options-actions';
		const moveUpButton = document.createElement('button');
		moveUpButton.type = 'button';
		moveUpButton.className = 'kv-button kv-button-tertiary kv-column-options-action';
		moveUpButton.dataset.role = 'move-up';
		moveUpButton.dataset.index = String(index);
		moveUpButton.innerHTML = '<span class="codicon codicon-arrow-up"></span>';
		moveUpButton.title = '上移';
		moveUpButton.disabled = index === 0;
		actions.appendChild(moveUpButton);
		const moveDownButton = document.createElement('button');
		moveDownButton.type = 'button';
		moveDownButton.className = 'kv-button kv-button-tertiary kv-column-options-action';
		moveDownButton.dataset.role = 'move-down';
		moveDownButton.dataset.index = String(index);
		moveDownButton.innerHTML = '<span class="codicon codicon-arrow-down"></span>';
		moveDownButton.title = '下移';
		moveDownButton.disabled = index === options.length - 1;
		actions.appendChild(moveDownButton);
		const removeButton = document.createElement('button');
		removeButton.type = 'button';
		removeButton.className = 'kv-button kv-button-tertiary kv-column-options-action';
		removeButton.dataset.role = 'remove';
		removeButton.dataset.index = String(index);
		removeButton.innerHTML = '<span class="codicon codicon-trash"></span>';
		removeButton.title = '删除';
		actions.appendChild(removeButton);
		row.appendChild(actions);
		listContainer.appendChild(row);
	});
}

function handleColumnOptionsEditorInput(event) {
	if (!columnOptionsEditorState) {
		return;
	}
	const target = event.target;
	if (!(target instanceof HTMLInputElement)) {
		return;
	}
	const index = Number(target.dataset.index ?? '-1');
	if (Number.isNaN(index) || index < 0) {
		return;
	}
	const entry = columnOptionsEditorState.options[index];
	if (!entry) {
		return;
	}
	const role = target.dataset.role;
	if (role === 'value') {
		entry.value = target.value;
		if (entry.labelIsFallback) {
			entry.label = entry.value;
		}
	} else if (role === 'label') {
		const rawLabel = target.value;
		entry.label = rawLabel;
		entry.labelIsFallback = rawLabel.trim().length === 0;
		if (entry.labelIsFallback) {
			entry.label = entry.value;
		}
	} else if (role === 'description') {
		entry.description = target.value;
	}
	resetColumnOptionsEditorError();
}

function handleColumnOptionsEditorClick(event) {
	if (!columnOptionsEditorState) {
		return;
	}
	const target = event.target instanceof HTMLElement ? event.target.closest('button[data-role]') : null;
	if (!(target instanceof HTMLButtonElement)) {
		return;
	}
	const index = Number(target.dataset.index ?? '-1');
	if (Number.isNaN(index) || index < 0) {
		return;
	}
	const role = target.dataset.role;
	const { options } = columnOptionsEditorState;
	if (role === 'remove') {
		options.splice(index, 1);
		renderColumnOptionsEditorOptions();
		resetColumnOptionsEditorError();
		if (options.length) {
			const focusIndex = Math.min(index, options.length - 1);
			focusColumnOptionsEditorInput(focusIndex, 'value');
		}
		return;
	}
	if (role === 'move-up' && index > 0) {
		const temp = options[index - 1];
		options[index - 1] = options[index];
		options[index] = temp;
		renderColumnOptionsEditorOptions();
		focusColumnOptionsEditorInput(index - 1, 'value');
		resetColumnOptionsEditorError();
		return;
	}
	if (role === 'move-down' && index < options.length - 1) {
		const temp = options[index + 1];
		options[index + 1] = options[index];
		options[index] = temp;
		renderColumnOptionsEditorOptions();
		focusColumnOptionsEditorInput(index + 1, 'value');
		resetColumnOptionsEditorError();
	}
}

function focusColumnOptionsEditorInput(index, role) {
	if (!columnOptionsEditorState) {
		return;
	}
	window.requestAnimationFrame(() => {
		if (!columnOptionsEditorState) {
			return;
		}
		const selector = `.kv-column-options-input[data-role="${role}"][data-index="${index}"]`;
		const input = columnOptionsEditorState.listContainer.querySelector(selector);
		if (input instanceof HTMLInputElement) {
			input.focus({ preventScroll: false });
			if (role === 'value' || role === 'label') {
				input.select();
			}
		}
	});
}

function validateColumnOptionsEntries(entries) {
	const seen = new Set();
	for (let i = 0; i < entries.length; i += 1) {
		const value = (entries[i].value || '').trim();
		if (!value) {
			return { valid: false, message: `第 ${i + 1} 行的选项值不能为空。` };
		}
		const key = value.toLowerCase();
		if (seen.has(key)) {
			return { valid: false, message: `选项值 "${value}" 重复。` };
		}
		seen.add(key);
	}
	return { valid: true };
}

function submitColumnOptionsEditor() {
	if (!columnOptionsEditorState) {
		return;
	}
	resetColumnOptionsEditorError();
	const { column, folderType, options, scopeCheckbox, multiSelectCheckbox, separatorInput } = columnOptionsEditorState;
	const isFileScope = scopeCheckbox ? scopeCheckbox.checked : true; // 默认勾选
	const isMultiple = multiSelectCheckbox ? multiSelectCheckbox.checked : false;
	const separator = separatorInput ? (separatorInput.value || '|') : '|';
	const normalized = options.map((option) => {
		const value = (option.value || '').trim();
		const description = (option.description || '').trim();
		const hasFallback = option.labelIsFallback === true;
		const rawLabel = hasFallback ? '' : (option.label || '').trim();
		const labelIsFallback = hasFallback || rawLabel.length === 0;
		return {
			value,
			label: rawLabel,
			description,
			labelIsFallback,
		};
	});
	const validation = validateColumnOptionsEntries(normalized);
	if (!validation.valid) {
		setColumnOptionsEditorError(validation.message || '存在未通过校验的内容。');
		return;
	}
	const payloadOptions = normalized.map((entry) => {
		const result = {
			value: entry.value,
		};
		if (!entry.labelIsFallback && entry.label.length) {
			result.label = entry.label;
		}
		if (entry.description) {
			result.description = entry.description;
		}
		return result;
	});
	vscode.postMessage({
		type: 'saveColumnOptions',
		payload: {
			column,
			folderType,
			options: payloadOptions,
			multiple: isMultiple,
			separator: separator,
			scope: isFileScope ? 'file' : 'global',
		},
	});
	closeColumnOptionsEditor();
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

function requestRowReorder(sourceId, sourceIndex, targetIndex) {
	if (!sourceId || typeof sourceIndex !== 'number' || Number.isNaN(sourceIndex) || typeof targetIndex !== 'number' || Number.isNaN(targetIndex)) {
		return;
	}
	vscode.postMessage({
		type: 'reorderRows',
		payload: {
			sourceId,
			sourceIndex,
			targetIndex,
		},
	});
}

function requestColumnReorder(sourceKey, sourceIndex, targetIndex) {
	if (!sourceKey || typeof sourceIndex !== 'number' || Number.isNaN(sourceIndex) || typeof targetIndex !== 'number' || Number.isNaN(targetIndex)) {
		return;
	}
	vscode.postMessage({
		type: 'reorderColumns',
		payload: {
			sourceKey,
			sourceIndex,
			targetIndex,
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

function handleColumnDragStart(event, columnKey, columnIndex, handleElement) {
	if (!event || columnIndex <= 0 || !latestPayload?.columns?.length) {
		if (event) {
			event.preventDefault();
		}
		return;
	}
	columnDragState = {
		sourceKey: columnKey,
		sourceIndex: columnIndex,
		targetIndex: undefined,
		targetHeader: null,
		dropPosition: null,
		handle: handleElement || null,
	};
	if (event.dataTransfer) {
		event.dataTransfer.effectAllowed = 'move';
		event.dataTransfer.setData('text/plain', columnKey ?? '');
	}
	if (handleElement instanceof HTMLElement) {
		handleElement.classList.add('kv-column-letter-dragging');
	}
	document.body.classList.add('kv-column-dragging');
}

function handleColumnDragEnd(event, handleElement) {
	if (handleElement instanceof HTMLElement) {
		handleElement.classList.remove('kv-column-letter-dragging');
	}
	cleanupColumnDragState();
}


function handleColumnDragOver(event, headerElement, columnKey, columnIndex) {
	if (!columnDragState || !Array.isArray(latestPayload?.columns) || columnIndex < 0 || !headerElement) {
		return;
	}
	const columns = latestPayload.columns;
	const rect = headerElement.getBoundingClientRect();
	const center = rect.left + rect.width / 2;
	let position = event.clientX < center ? 'before' : 'after';
	if (columnIndex === 0 && position === 'before') {
		position = 'after';
	}
	let dropIndex = position === 'before' ? columnIndex : columnIndex + 1;
	dropIndex = Math.max(1, Math.min(dropIndex, columns.length));
	const sourceIndex = columnDragState.sourceIndex;
	let effectiveTarget = dropIndex;
	if (dropIndex > sourceIndex) {
		effectiveTarget -= 1;
	}
	if (!Number.isInteger(effectiveTarget) || effectiveTarget === sourceIndex || effectiveTarget < 1) {
		columnDragState.targetIndex = undefined;
		clearColumnDropIndicator();
		return;
	}
	columnDragState.targetIndex = dropIndex;
	columnDragState.dropPosition = position;
	setColumnDropIndicator(headerElement, position);
	if (event) {
		event.preventDefault();
		if (event.dataTransfer) {
			event.dataTransfer.dropEffect = 'move';
		}
	}
}

function handleColumnDragLeave(event, headerElement) {
	if (!columnDragState || !headerElement) {
		return;
	}
	const related = event?.relatedTarget;
	if (related && headerElement.contains(related)) {
		return;
	}
	if (columnDragState.targetHeader === headerElement) {
		headerElement.classList.remove('kv-column-drop-target-before', 'kv-column-drop-target-after');
		columnDragState.targetHeader = null;
		columnDragState.targetIndex = undefined;
		columnDragState.dropPosition = null;
	}
}

function handleColumnDrop(event, columnKey) {
	if (!columnDragState) {
		return;
	}
	if (event) {
		event.preventDefault();
	}
	const { sourceKey, sourceIndex, targetIndex } = columnDragState;
	if (sourceKey && typeof targetIndex === 'number') {
		let finalIndex = targetIndex;
		if (finalIndex > sourceIndex) {
			finalIndex -= 1;
		}
		const maxIndex = Math.max(1, ((latestPayload?.columns?.length ?? 1) - 1));
		finalIndex = Math.max(1, Math.min(finalIndex, maxIndex));
		if (finalIndex !== sourceIndex) {
			requestColumnReorder(sourceKey, sourceIndex, finalIndex);
		}
	}
	cleanupColumnDragState();
}

function setColumnDropIndicator(headerElement, position) {
	if (!columnDragState || !headerElement) {
		return;
	}
	if (columnDragState.targetHeader && columnDragState.targetHeader !== headerElement) {
		columnDragState.targetHeader.classList.remove('kv-column-drop-target-before', 'kv-column-drop-target-after');
	}
	headerElement.classList.toggle('kv-column-drop-target-before', position === 'before');
	headerElement.classList.toggle('kv-column-drop-target-after', position === 'after');
	columnDragState.targetHeader = headerElement;
}

function clearColumnDropIndicator() {
	if (columnDragState?.targetHeader) {
		columnDragState.targetHeader.classList.remove('kv-column-drop-target-before', 'kv-column-drop-target-after');
		columnDragState.targetHeader = null;
	}
}

function cleanupColumnDragState() {
	clearColumnDropIndicator();
	if (columnDragState?.handle instanceof HTMLElement) {
		columnDragState.handle.classList.remove('kv-column-letter-dragging');
	}
	columnDragState = null;
	document.body.classList.remove('kv-column-dragging');
}

function handleRowDragStart(event, rowId, rowIndex, totalRows) {
	if (!rowId) {
		event.preventDefault();
		return;
	}
	rowDragState = {
		sourceId: rowId,
		sourceIndex: rowIndex,
		totalRows,
		placeholder: null,
	};
	event.dataTransfer.effectAllowed = 'move';
	event.dataTransfer.setData('text/plain', rowId);
	const handle = event.currentTarget;
	if (handle instanceof HTMLElement) {
		handle.classList.add('kv-row-dragging');
	}
	requestAnimationFrame(() => {
		if (rowDragState) {
			rowDragState.placeholder = createRowPlaceholder();
		}
	});
}

function handleRowDragEnd(event) {
	cleanupDragIndicators();
	const handle = event.currentTarget;
	if (handle instanceof HTMLElement) {
		handle.classList.remove('kv-row-dragging');
	}
}

function handleRowDragEnter(event, rowElement) {
	if (!rowDragState || !rowElement || !rowElement.parentElement) {
		return;
	}
	if (!isValidDropTarget(rowElement)) {
		return;
	}
	event.preventDefault();
	rowElement.classList.add('kv-row-drop-target');
	insertPlaceholder(rowElement, event.clientY);
}

function handleRowDragOver(event, rowElement) {
	if (!rowDragState || !rowElement || !rowElement.parentElement) {
		return;
	}
	if (!isValidDropTarget(rowElement)) {
		return;
	}
	event.preventDefault();
	event.dataTransfer.dropEffect = 'move';
	rowElement.classList.add('kv-row-drop-target');
	insertPlaceholder(rowElement, event.clientY);
}

function handleRowDragLeave(rowElement) {
	if (!rowElement) {
		return;
	}
	rowElement.classList.remove('kv-row-drop-target');
}

function handleRowDrop(event, rowElement) {
	if (!rowDragState || !rowElement) {
		return;
	}
	event.preventDefault();
	let targetIndex = computePlaceholderIndex(rowElement.parentElement);
	if (typeof targetIndex === 'number') {
		if (targetIndex > rowDragState.sourceIndex) {
			targetIndex -= 1;
		}
		if (targetIndex !== rowDragState.sourceIndex) {
			requestRowReorder(rowDragState.sourceId, rowDragState.sourceIndex, targetIndex);
		}
	}
	cleanupDragIndicators();
}

function handleRowContainerDragOver(event, tbody) {
	if (!rowDragState || !tbody) {
		return;
	}
	if (!tbody.contains(event.target)) {
		return;
	}
	event.preventDefault();
	event.dataTransfer.dropEffect = 'move';
	insertPlaceholderIntoContainer(tbody, event.clientY);
}

function handleRowContainerDragLeave(event, tbody) {
	if (!rowDragState || !tbody) {
		return;
	}
	if (!tbody.contains(event.relatedTarget)) {
		cleanupDragIndicators();
	}
}

function handleRowContainerDrop(event, tbody) {
	if (!rowDragState || !tbody) {
		return;
	}
	event.preventDefault();
	let targetIndex = computePlaceholderIndex(tbody);
	if (typeof targetIndex === 'number') {
		if (targetIndex > rowDragState.sourceIndex) {
			targetIndex -= 1;
		}
		if (targetIndex !== rowDragState.sourceIndex) {
			requestRowReorder(rowDragState.sourceId, rowDragState.sourceIndex, targetIndex);
		}
	}
	cleanupDragIndicators();
}

function cleanupDragIndicators() {
	if (rowDragState?.placeholder) {
		rowDragState.placeholder.remove();
	}
	const highlighted = tableSection?.querySelectorAll('.kv-row-drop-target');
	if (highlighted) {
		highlighted.forEach((row) => row.classList.remove('kv-row-drop-target'));
	}
	const draggingHandles = tableSection?.querySelectorAll('.kv-row-drag-btn.kv-row-dragging');
	if (draggingHandles) {
		draggingHandles.forEach((handle) => handle.classList.remove('kv-row-dragging'));
	}
	rowDragState = null;
}

function isValidDropTarget(rowElement) {
	if (!rowDragState || !rowElement) {
		return false;
	}
	const rowId = rowElement.dataset.rowId;
	if (!rowId || rowId === rowDragState.sourceId) {
		return false;
	}
	return true;
}

function insertPlaceholder(rowElement, clientY) {
	if (!rowDragState || !rowElement || !rowElement.parentElement) {
		return;
	}
	const tbody = rowElement.parentElement;
	const placeholder = rowDragState.placeholder ?? createRowPlaceholder();
	rowDragState.placeholder = placeholder;
	const rect = rowElement.getBoundingClientRect();
	const shouldInsertBefore = clientY < rect.top + rect.height / 2;
	if (shouldInsertBefore) {
		if (rowElement.previousSibling !== placeholder) {
			tbody.insertBefore(placeholder, rowElement);
		}
	} else if (rowElement.nextSibling !== placeholder) {
		tbody.insertBefore(placeholder, rowElement.nextSibling);
	}
}

function insertPlaceholderIntoContainer(tbody, clientY) {
	if (!rowDragState || !tbody) {
		return;
	}
	const placeholder = rowDragState.placeholder ?? createRowPlaceholder();
	rowDragState.placeholder = placeholder;
	const rows = Array.from(tbody.querySelectorAll('tr.kv-row'));
	if (!rows.length) {
		tbody.appendChild(placeholder);
		return;
	}
	let inserted = false;
	for (const row of rows) {
		const rect = row.getBoundingClientRect();
		if (clientY < rect.top + rect.height / 2) {
			if (row.previousSibling !== placeholder) {
				tbody.insertBefore(placeholder, row);
			}
			inserted = true;
			break;
		}
	}
	if (!inserted && rows[rows.length - 1].nextSibling !== placeholder) {
		tbody.appendChild(placeholder);
	}
}

function computePlaceholderIndex(container) {
	if (!rowDragState || !container) {
		return undefined;
	}
	const rows = Array.from(container.querySelectorAll('tr.kv-row'));
	const placeholder = rowDragState.placeholder;
	if (!rows.length || !placeholder) {
		return undefined;
	}
	const siblings = Array.from(container.children);
	const placeholderIndex = siblings.indexOf(placeholder);
	if (placeholderIndex === -1) {
		return undefined;
	}
	const targetIndex = siblings.slice(0, placeholderIndex).filter((node) => node.classList?.contains?.('kv-row')).length;
	return targetIndex;
}

function createRowPlaceholder() {
	const placeholder = document.createElement('tr');
	placeholder.className = 'kv-row-placeholder';
	const headerCells = tableSection?.querySelectorAll('thead th');
	const colSpan = Math.max(1, headerCells ? headerCells.length : 1);
	const td = document.createElement('td');
	td.colSpan = colSpan;
	placeholder.appendChild(td);
	return placeholder;
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

	// 对于物品图标，同时匹配带和不带 item_ 前缀的情况
	if (icon.kind === 'item') {
		const withPrefix = textureNameLower.startsWith('item_') ? textureNameLower : 'item_' + textureNameLower;
		const withoutPrefix = textureNameLower.startsWith('item_') ? textureNameLower.substring(5) : textureNameLower;
		if (withPrefix.includes(keyword) || withoutPrefix.includes(keyword)) {
			return true;
		}
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
			// 比较时考虑物品图标的 item_ 前缀
			let iconValueForComparison = icon.textureName.toLowerCase();
			if (icon.kind === 'item' && !iconValueForComparison.startsWith('item_')) {
				iconValueForComparison = 'item_' + iconValueForComparison;
			}
			if (iconValueForComparison === currentValue) {
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
	// 对于物品图标，确保有 item_ 前缀
	let newValue = icon.textureName;
	if (icon.kind === 'item' && !newValue.startsWith('item_')) {
		newValue = 'item_' + newValue;
	}
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

function applyColumnLayout(columns, layout) {
	if (!Array.isArray(columns) || !layout || typeof layout !== 'object') {
		return;
	}
	const widths = layout.columnWidths;
	if (!widths || typeof widths !== 'object') {
		return;
	}
	for (const column of columns) {
		if (column === ROW_NUMBER_COLUMN_KEY) {
			continue;
		}
		const saved = widths[column];
		if (typeof saved !== 'number' || !Number.isFinite(saved)) {
			continue;
		}
		const normalized = Math.max(getMinColumnWidth(column), Math.round(saved));
		columnWidths[column] = normalized;
		originalColumnWidths[column] = normalized;
		savedColumnWidths.add(column); // 记录该列是从配置加载的
		modifiedColumns.delete(column);
	}
}

// 根据扩展端消息刷新整体界面
function render(payload) {
	if (!payload) {
		return;
	}
	cancelColumnWidthSave();
	const nextDocumentKey = (payload.documentKey || payload.fileName || '').toString();
	if (currentDocumentKey !== nextDocumentKey) {
		resetColumnState();
		currentDocumentKey = nextDocumentKey;
	}
	latestPayload = payload;

	// 加载列描述配置
	if (payload.columnDescriptions && typeof payload.columnDescriptions === 'object') {
		columnDescriptions = { ...payload.columnDescriptions };
	}

	// 加载冻结列配置（从保存的最右侧列key恢复整个冻结列集合）
	if (typeof payload.frozenColumns === 'string' && payload.frozenColumns.length > 0) {
		frozenColumns.clear();
		if (payload.columns && Array.isArray(payload.columns)) {
			const targetIndex = payload.columns.indexOf(payload.frozenColumns);
			if (targetIndex >= 0) {
				for (let i = 0; i <= targetIndex; i++) {
					frozenColumns.add(payload.columns[i]);
				}
			}
		}
	} else if (payload.frozenColumns === null || payload.frozenColumns === undefined || payload.frozenColumns === '') {
		frozenColumns.clear();
	}

	// 加载精简模式设置
	if (typeof payload.compactMode === 'boolean') {
		compactMode = payload.compactMode;
		if (toggleCompactModeBtn) {
			if (compactMode) {
				toggleCompactModeBtn.classList.add('active');
				toggleCompactModeBtn.title = '精简模式已开启，点击关闭';
			} else {
				toggleCompactModeBtn.classList.remove('active');
				toggleCompactModeBtn.title = '精简模式已关闭，点击开启';
			}
		}
	}

	// 加载本地化模式设置
	if (typeof payload.localizedMode === 'boolean') {
		localizedMode = payload.localizedMode;
		if (toggleLocalizedModeBtn) {
			if (localizedMode) {
				toggleLocalizedModeBtn.classList.add('active');
				toggleLocalizedModeBtn.title = '本地化模式已开启，显示描述';
			} else {
				toggleLocalizedModeBtn.classList.remove('active');
				toggleLocalizedModeBtn.title = '本地化模式已关闭，显示原文';
			}
		}
	}

	applyFormulaDefinitions(payload.formulas);
	// 初始加载时重新计算公式，如果发现值不一致则同步到文件
	recalculateFormulas({ emitUpdates: true });
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
	applyColumnLayout(payload.columns, payload.columnLayout);
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