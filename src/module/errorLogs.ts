import * as vscode from 'vscode';
import { EventManager, EventType } from '../Class/event';
import { ErrorLogTreeProvider } from '../TreeDataProvider/errorLogTree';

let provider: ErrorLogTreeProvider | undefined;
let configListenerId: number | undefined;


export async function errorLogsInit(context: vscode.ExtensionContext) {
	if (!provider) {
		provider = new ErrorLogTreeProvider(context);
		vscode.window.registerTreeDataProvider('errorLogExplorer', provider);
		context.subscriptions.push(provider);
	}

	provider.refresh();

	if (configListenerId === undefined) {
		configListenerId = EventManager.listenToEvent<vscode.ConfigurationChangeEvent>(EventType.EVENT_ON_DID_CHANGE_CONFIGURATION, (event) => {
			if (event.affectsConfiguration('dota2-tools.A9.LogServer') || event.affectsConfiguration('dota2-tools.A9.recentDays')) {
				provider?.refresh();
			}
		});

		context.subscriptions.push({
			dispose: () => {
				if (configListenerId !== undefined) {
					EventManager.stopListenToEvent(EventType.EVENT_ON_DID_CHANGE_CONFIGURATION, configListenerId);
					configListenerId = undefined;
				}
			}
		});
	}
}
