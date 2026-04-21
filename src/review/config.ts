import type { ConfigStore, SchematicFieldsConfig } from './types';
/**
 * AI schematic review - configuration management
 *
 * Uses `eda.sys_Storage` to persist AI review settings.
 * Note: `localStorage` is not available in the extension host context.
 */
import { AIProvider, DEFAULT_SCHEMATIC_FIELDS } from './types';

const CONFIG_KEY = 'ai-sch-review-config';
const HISTORY_KEY = 'ai-sch-chat-history';

/**
 * Normalize `schematicFields` by merging stored values into the defaults
 * and filtering out any non-boolean values.
 */
function mergeSchematicFields(saved?: unknown): Required<SchematicFieldsConfig> {
	const merged: Required<SchematicFieldsConfig> = { ...DEFAULT_SCHEMATIC_FIELDS };
	if (!saved || typeof saved !== 'object' || Array.isArray(saved)) {
		return merged;
	}
	const raw = saved as Record<string, unknown>;
	const keys = Object.keys(DEFAULT_SCHEMATIC_FIELDS) as Array<keyof SchematicFieldsConfig>;
	for (const key of keys) {
		if (typeof raw[key] === 'boolean') {
			(merged as Record<string, boolean>)[key] = raw[key] as boolean;
		}
	}
	return merged;
}

/**
 * Default configuration.
 */
const DEFAULT_CONFIG: ConfigStore = {
	provider: AIProvider.OPENAI_COMPATIBLE,
	apiKey: '',
	model: 'gpt-4o',
	apiUrl: 'https://api.openai.com/v1/chat/completions',
	maxPinsPerChunk: 1200,
	windowWidth: 960,
	windowHeight: 700,
	mcpEnabled: false,
	mcpGatewayUrl: '',
	mcpGatewayApiKey: '',
	mcpAutoApprove: true,
	mcpBridgeUrl: 'ws://127.0.0.1:3100',
	customSystemPrompt: '',
	schematicFields: { ...DEFAULT_SCHEMATIC_FIELDS },
};

// ============ Storage Corruption Detection and Repair ============

/**
 * Check whether an error was caused by corrupted extension storage.
 */
function isStorageCorruptionError(e: unknown): boolean {
	const msg = e instanceof Error ? e.message : String(e);
	return msg.includes('Cannot create property');
}

/**
 * Detect and repair corrupted extension storage.
 */
async function repairStorageIfCorrupted(): Promise<boolean> {
	try {
		const allConfigs = eda.sys_Storage.getExtensionAllUserConfigs?.();
		const corrupted = allConfigs !== undefined
			&& (allConfigs === null || Array.isArray(allConfigs) || typeof allConfigs !== 'object');
		if (corrupted) {
			console.warn('[config] Corrupted storage detected. Attempting repair...', typeof allConfigs);
			const cleared = await eda.sys_Storage.clearExtensionAllUserConfigs?.();
			return cleared === true;
		}
	}
	catch {
		// Ignore: some EasyEDA versions may not support these APIs.
	}
	return false;
}

// ============ Config Read / Write ============

/**
 * Load configuration from `eda.sys_Storage`.
 */
export function loadConfig(): ConfigStore {
	try {
		const raw = eda.sys_Storage.getExtensionUserConfig(CONFIG_KEY);
		if (!raw) {
			return { ...DEFAULT_CONFIG, schematicFields: { ...DEFAULT_SCHEMATIC_FIELDS } };
		}
		const parsed = typeof raw === 'string' ? JSON.parse(raw) as Partial<ConfigStore> : raw as Partial<ConfigStore>;
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
			void repairStorageIfCorrupted();
			return { ...DEFAULT_CONFIG, schematicFields: { ...DEFAULT_SCHEMATIC_FIELDS } };
		}
		const merged: ConfigStore = { ...DEFAULT_CONFIG, ...parsed };
		merged.schematicFields = mergeSchematicFields(parsed.schematicFields);
		return merged;
	}
	catch {
		void repairStorageIfCorrupted();
		return { ...DEFAULT_CONFIG, schematicFields: { ...DEFAULT_SCHEMATIC_FIELDS } };
	}
}

/**
 * Save configuration to `eda.sys_Storage`.
 */
export async function saveConfig(config: Partial<ConfigStore>): Promise<{ success: boolean; config: ConfigStore; error?: string }> {
	const current = loadConfig();
	const merged: ConfigStore = { ...current, ...config };
	try {
		const success = await eda.sys_Storage.setExtensionUserConfig(CONFIG_KEY, merged);
		if (!success) {
			return { success: false, config: current, error: 'Failed to write configuration to storage' };
		}
		const saved = loadConfig();
		return { success: true, config: saved };
	}
	catch (e) {
		const errMsg = e instanceof Error ? e.message : String(e);

		if (isStorageCorruptionError(e) && await repairStorageIfCorrupted()) {
			console.warn('[config] Save failed due to corrupted storage. Retrying after repair.');
			try {
				const retrySuccess = await eda.sys_Storage.setExtensionUserConfig(CONFIG_KEY, merged);
				if (retrySuccess) {
					const saved = loadConfig();
					return { success: true, config: saved };
				}
			}
			catch (retryError) {
				console.warn('[config] Retry after repair still failed:', retryError);
			}
		}

		console.warn('Failed to save configuration:', e);
		return { success: false, config: current, error: errMsg };
	}
}

/**
 * Validate whether a configuration is usable for AI requests.
 */
export function validateConfig(config: ConfigStore): string | null {
	if (!config.apiKey || config.apiKey.trim().length === 0) {
		return 'API key is not configured';
	}
	if (!config.model || config.model.trim().length === 0) {
		return 'Model is not configured';
	}
	if (!config.apiUrl || config.apiUrl.trim().length === 0) {
		return 'API URL is not configured';
	}

	if (config.mcpEnabled) {
		if (!config.mcpGatewayUrl || config.mcpGatewayUrl.trim().length === 0) {
			return 'MCP gateway URL is not configured';
		}
		try {
			const gatewayUrl = new URL(config.mcpGatewayUrl);
			if (gatewayUrl.protocol !== 'http:' && gatewayUrl.protocol !== 'https:') {
				return 'MCP gateway URL must use HTTP or HTTPS';
			}
		}
		catch {
			return 'MCP gateway URL is invalid';
		}
	}

	return null;
}

// ============ Chat History ============

/**
 * Load chat history.
 */
export function loadChatHistory(): unknown[] {
	try {
		const raw = eda.sys_Storage.getExtensionUserConfig(HISTORY_KEY);
		if (!raw) {
			return [];
		}
		const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
		return Array.isArray(parsed) ? parsed : [];
	}
	catch {
		void repairStorageIfCorrupted();
		return [];
	}
}

/**
 * Save chat history.
 */
export async function saveChatHistory(messages: unknown[]): Promise<{ success: boolean; error?: string }> {
	try {
		const success = await eda.sys_Storage.setExtensionUserConfig(HISTORY_KEY, messages);
		if (!success) {
			return { success: false, error: 'Failed to write chat history to storage' };
		}
		return { success: true };
	}
	catch (e) {
		const errMsg = e instanceof Error ? e.message : String(e);

		if (isStorageCorruptionError(e) && await repairStorageIfCorrupted()) {
			console.warn('[config] Chat history save failed due to corrupted storage. Retrying after repair.');
			try {
				const retrySuccess = await eda.sys_Storage.setExtensionUserConfig(HISTORY_KEY, messages);
				if (retrySuccess) {
					return { success: true };
				}
			}
			catch (retryError) {
				console.warn('[config] Chat history retry after repair still failed:', retryError);
			}
		}

		console.warn('Failed to save chat history:', e);
		return { success: false, error: errMsg };
	}
}

/**
 * Show a basic configuration dialog.
 */
export function showConfigDialog(): void {
	const config = loadConfig();

	eda.sys_Dialog.showInformationMessage(
		`Current configuration:
Provider: ${config.provider}
Model: ${config.model}
API Key: ${config.apiKey ? 'Configured' : 'Not configured'}

Open the review panel and click "Configure AI" to edit these settings.`,
		'AI Review Configuration',
	);
}
