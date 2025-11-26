import * as vscode from 'vscode';
import { getWebviewContent } from '../utils/getWebViewContent';
import { readKeyValue2, writeKeyValue } from '../utils/kvUtils';

/**
 * 行为树节点类型
 */
export interface BehaviorTreeNode {
	id: string;
	key: string; // 英文标识符,用于KV键名
	type: 'Root' | 'Sequence' | 'Selector' | 'Parallel' | 'Condition' | 'Action' | 'Decorator';
	name: string; // 中文可读名称,对应KV的Name字段
	description?: string;
	children?: BehaviorTreeNode[];
	x?: number;
	y?: number;
	[key: string]: any; // 其他自定义属性
}

/**
 * 行为树文档数据
 */
interface BehaviorTreeDocument {
	name: string;
	description?: string;
	root: BehaviorTreeNode;
}

export class BehaviorTreeProvider implements vscode.CustomTextEditorProvider {

	public static register(context: vscode.ExtensionContext): vscode.Disposable {
		return vscode.window.registerCustomEditorProvider(
			BehaviorTreeProvider.viewType,
			new BehaviorTreeProvider(context),
			{
				webviewOptions: {
					retainContextWhenHidden: true,
					enableFindWidget: false,
				}
			}
		);
	}

	private static readonly viewType = 'dota2tools.behaviorTree';

	constructor(private readonly context: vscode.ExtensionContext) { }

	public async resolveCustomTextEditor(
		document: vscode.TextDocument,
		webviewPanel: vscode.WebviewPanel,
		_token: vscode.CancellationToken
	): Promise<void> {
		webviewPanel.webview.options = {
			enableScripts: true,
		};

		webviewPanel.webview.html = await getWebviewContent(
			webviewPanel.webview,
			this.context.extensionUri,
			'BehaviorTree'
		);

		let webviewReady = false;
		let pendingData: any = undefined;

		// 发送数据到 webview
		const postData = (data: any) => {
			if (!webviewReady) {
				pendingData = data;
				return;
			}
			webviewPanel.webview.postMessage({ type: 'update', data });
		};

		// 更新 webview
		const updateWebview = () => {
			try {
				const treeData = this.parseDocument(document);
				postData(treeData);
			} catch (error) {
				vscode.window.showErrorMessage(`解析行为树文件失败: ${error}`);
			}
		};

		// 监听文档变化
		const changeDocumentSubscription = vscode.workspace.onDidChangeTextDocument((event) => {
			if (event.document.uri.toString() === document.uri.toString()) {
				updateWebview();
			}
		});

		// 监听 webview 消息
		const messageListener = webviewPanel.webview.onDidReceiveMessage((message) => {
			if (!message || typeof message.type !== 'string') {
				return;
			}

			switch (message.type) {
				case 'ready':
					webviewReady = true;
					if (pendingData) {
						postData(pendingData);
						pendingData = undefined;
					} else {
						updateWebview();
					}
					break;

				case 'save':
					this.saveDocument(document, message.data).catch((error) => {
						vscode.window.showErrorMessage(`保存行为树失败: ${error}`);
					});
					break;

				case 'openInTextEditor':
					// 在右侧打开文本编辑器
					vscode.commands.executeCommand('vscode.openWith', document.uri, 'default', vscode.ViewColumn.Beside);
					break;

				case 'error':
					vscode.window.showErrorMessage(message.message);
					break;

				case 'saveTemplate':
					this.saveTemplate(message.template).then(() => {
						vscode.window.showInformationMessage(`模板 "${message.template.name}" 已保存`);
						// 发送更新后的模板列表
						this.getTemplates().then(templates => {
							webviewPanel.webview.postMessage({ type: 'templatesUpdated', templates });
						});
					}).catch(error => {
						vscode.window.showErrorMessage(`保存模板失败: ${error}`);
					});
					break;

				case 'getTemplates':
					this.getTemplates().then(templates => {
						webviewPanel.webview.postMessage({ type: 'templatesUpdated', templates });
					}).catch(error => {
						vscode.window.showErrorMessage(`获取模板失败: ${error}`);
					});
					break;

				case 'deleteTemplate':
					this.deleteTemplate(message.templateName).then(() => {
						vscode.window.showInformationMessage(`模板 "${message.templateName}" 已删除`);
						// 发送更新后的模板列表
						this.getTemplates().then(templates => {
							webviewPanel.webview.postMessage({ type: 'templatesUpdated', templates });
						});
					}).catch(error => {
						vscode.window.showErrorMessage(`删除模板失败: ${error}`);
					});
					break;
			}
		});

		webviewPanel.onDidDispose(() => {
			changeDocumentSubscription.dispose();
			messageListener.dispose();
		});
	}

	/**
	 * 解析文档为行为树数据
	 */
	private parseDocument(document: vscode.TextDocument): BehaviorTreeDocument {
		const text = document.getText();
		console.log('Parsing document text:', text.substring(0, 200));
		const kvData = readKeyValue2(text);
		console.log('Parsed KV data:', JSON.stringify(kvData, null, 2));

		if (!kvData || typeof kvData !== 'object') {
			throw new Error('无效的行为树文件格式');
		}

		// 获取根节点键名
		const rootKey = Object.keys(kvData)[0];
		if (!rootKey) {
			throw new Error('行为树文件为空');
		}

		const rootData = kvData[rootKey];
		const result = {
			name: rootKey,
			description: rootData.Description,
			root: this.parseNode(rootData, rootKey)
		};

		console.log('Parsed tree document:', JSON.stringify(result, null, 2));
		return result;
	}

	/**
	 * 递归解析节点
	 */
	private parseNode(nodeData: any, nodeName: string, parentId: string = ''): BehaviorTreeNode {
		const nodeId = parentId ? `${parentId}_${nodeName}` : nodeName;

		const node: BehaviorTreeNode = {
			id: nodeId,
			key: nodeName, // 键名作为英文标识符
			type: nodeData.Type || 'Action',
			name: nodeData.Name || nodeName, // Name字段作为中文名称
			description: nodeData.Description,
			x: nodeData.X ? parseFloat(nodeData.X) : undefined,
			y: nodeData.Y ? parseFloat(nodeData.Y) : undefined,
			children: [],
		};

		// 复制其他属性
		for (const key in nodeData) {
			if (!['Type', 'Name', 'Description', 'Children', 'X', 'Y'].includes(key)) {
				node[key] = nodeData[key];
			}
		}

		// 解析子节点
		if (nodeData.Children && typeof nodeData.Children === 'object') {
			for (const childName in nodeData.Children) {
				const childNode = this.parseNode(nodeData.Children[childName], childName, nodeId);
				node.children!.push(childNode);
			}
		}

		return node;
	}

	/**
	 * 保存文档
	 */
	private async saveDocument(document: vscode.TextDocument, treeData: BehaviorTreeDocument): Promise<void> {
		const kvData = this.buildKvData(treeData);
		const kvText = writeKeyValue(kvData);

		const edit = new vscode.WorkspaceEdit();
		const fullRange = new vscode.Range(
			document.positionAt(0),
			document.positionAt(document.getText().length)
		);
		edit.replace(document.uri, fullRange, kvText);

		await vscode.workspace.applyEdit(edit);
	}

	/**
	 * 构建 KV 数据
	 */
	private buildKvData(treeData: BehaviorTreeDocument): any {
		const rootNodeData = this.buildNodeData(treeData.root);

		if (treeData.description) {
			rootNodeData.Description = treeData.description;
		}

		return {
			[treeData.name]: rootNodeData
		};
	}

	/**
	 * 递归构建节点数据
	 */
	private buildNodeData(node: BehaviorTreeNode): any {
		const nodeData: any = {
			Type: node.type,
			Name: node.name, // 中文名称存到Name字段
		};

		if (node.description) {
			nodeData.Description = node.description;
		}

		if (node.x !== undefined) {
			nodeData.X = node.x.toString();
		}

		if (node.y !== undefined) {
			nodeData.Y = node.y.toString();
		}

		// 复制其他自定义属性
		for (const key in node) {
			if (!['id', 'key', 'type', 'name', 'description', 'children', 'x', 'y'].includes(key)) {
				const value = node[key];
				// 跳过空对象（如空的 Params）
				if (typeof value === 'object' && value !== null && Object.keys(value).length === 0) {
					continue;
				}
				nodeData[key] = value;
			}
		}

		// 处理子节点
		if (node.children && node.children.length > 0) {
			nodeData.Children = {};

			// 按照X坐标排序子节点（从左到右）
			const sortedChildren = [...node.children].sort((a, b) => {
				const xA = a.x !== undefined ? a.x : 0;
				const xB = b.x !== undefined ? b.x : 0;
				return xA - xB;
			});

			for (let i = 0; i < sortedChildren.length; i++) {
				const child = sortedChildren[i];
				const childData = this.buildNodeData(child);
				// 添加Index字段标记顺序（从1开始，按X坐标排序）
				childData.Index = (i + 1).toString();
				// 使用key作为KV键名
				nodeData.Children[child.key] = childData;
			}
		}

		return nodeData;
	}

	/**
	 * 获取模板配置文件路径
	 */
	private getTemplateConfigPath(): vscode.Uri | undefined {
		const workspaceFolders = vscode.workspace.workspaceFolders;
		if (!workspaceFolders || workspaceFolders.length === 0) {
			return undefined;
		}
		return vscode.Uri.joinPath(workspaceFolders[0].uri, '.vscode', 'behavior-tree-templates.json');
	}

	/**
	 * 获取所有模板
	 */
	private async getTemplates(): Promise<any[]> {
		const configPath = this.getTemplateConfigPath();
		if (!configPath) {
			return [];
		}

		try {
			const data = await vscode.workspace.fs.readFile(configPath);
			const config = JSON.parse(Buffer.from(data).toString('utf8'));
			return config.templates || [];
		} catch (error) {
			// 文件不存在或解析失败，返回空数组
			return [];
		}
	}

	/**
	 * 保存模板
	 */
	private async saveTemplate(template: any): Promise<void> {
		const configPath = this.getTemplateConfigPath();
		if (!configPath) {
			throw new Error('未找到工作区');
		}

		const templates = await this.getTemplates();

		// 检查是否已存在同名模板
		const existingIndex = templates.findIndex((t: any) => t.name === template.name);
		if (existingIndex >= 0) {
			// 替换已存在的模板
			templates[existingIndex] = template;
		} else {
			// 添加新模板
			templates.push(template);
		}

		const config = { templates };
		const content = JSON.stringify(config, null, '\t');

		// 确保目录存在
		const dirPath = vscode.Uri.joinPath(configPath, '..');
		try {
			await vscode.workspace.fs.createDirectory(dirPath);
		} catch (error) {
			// 目录可能已存在，忽略错误
		}

		await vscode.workspace.fs.writeFile(configPath, Buffer.from(content, 'utf8'));
	}

	/**
	 * 删除模板
	 */
	private async deleteTemplate(templateName: string): Promise<void> {
		const configPath = this.getTemplateConfigPath();
		if (!configPath) {
			throw new Error('未找到工作区');
		}

		const templates = await this.getTemplates();
		const filteredTemplates = templates.filter((t: any) => t.name !== templateName);

		const config = { templates: filteredTemplates };
		const content = JSON.stringify(config, null, '\t');
		await vscode.workspace.fs.writeFile(configPath, Buffer.from(content, 'utf8'));
	}
}
