import type { ConfigStore, SchematicFieldsConfig } from './types';
/**
 * AI原理图审查 - 配置管理
 *
 * 使用 eda.sys_Storage 持久化存储AI审查配置
 * 注意：扩展主上下文中 localStorage 不可用，必须使用 EDA 提供的存储 API
 */
import { AIProvider, DEFAULT_SCHEMATIC_FIELDS } from './types';

const CONFIG_KEY = 'ai-sch-review-config';
const HISTORY_KEY = 'ai-sch-chat-history';

/**
 * 归一化 schematicFields 配置：
 * 将存储中的字段值 merge 到默认配置，过滤非布尔值，保证结构完整
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
 * 默认配置
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

// ============ 存储污染检测与修复 ============

/**
 * 判断错误是否为存储污染导致
 */
function isStorageCorruptionError(e: unknown): boolean {
	const msg = e instanceof Error ? e.message : String(e);
	return msg.includes('Cannot create property');
}

/**
 * 检测并修复存储污染
 * 某些情况下扩展存储区可能被意外写入非对象值（如 API key 字符串），
 * 导致后续 setExtensionUserConfig 失败（Cannot create property on string）
 * 返回 true 表示污染已修复
 */
async function repairStorageIfCorrupted(): Promise<boolean> {
	try {
		const allConfigs = eda.sys_Storage.getExtensionAllUserConfigs?.();
		const corrupted = allConfigs !== undefined
			&& (allConfigs === null || Array.isArray(allConfigs) || typeof allConfigs !== 'object');
		if (corrupted) {
			console.warn('[config] 检测到存储污染，正在修复...', typeof allConfigs);
			const cleared = await eda.sys_Storage.clearExtensionAllUserConfigs?.();
			return cleared === true;
		}
	}
	catch {
		// 忽略：部分 EDA 版本可能不支持这些 API
	}
	return false;
}

// ============ 配置读写 ============

/**
 * 从 eda.sys_Storage 加载配置
 */
export function loadConfig(): ConfigStore {
	try {
		const raw = eda.sys_Storage.getExtensionUserConfig(CONFIG_KEY);
		if (!raw) {
			return { ...DEFAULT_CONFIG, schematicFields: { ...DEFAULT_SCHEMATIC_FIELDS } };
		}
		// raw 可能是对象或字符串
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
 * 保存配置到 eda.sys_Storage
 */
export async function saveConfig(config: Partial<ConfigStore>): Promise<{ success: boolean; config: ConfigStore; error?: string }> {
	const current = loadConfig();
	const merged: ConfigStore = { ...current, ...config };
	try {
		const success = await eda.sys_Storage.setExtensionUserConfig(CONFIG_KEY, merged);
		if (!success) {
			return { success: false, config: current, error: '存储写入失败' };
		}
		const saved = loadConfig();
		return { success: true, config: saved };
	}
	catch (e) {
		const errMsg = e instanceof Error ? e.message : String(e);

		if (isStorageCorruptionError(e) && await repairStorageIfCorrupted()) {
			console.warn('[config] 存储污染导致保存失败，修复后重试');
			try {
				const retrySuccess = await eda.sys_Storage.setExtensionUserConfig(CONFIG_KEY, merged);
				if (retrySuccess) {
					const saved = loadConfig();
					return { success: true, config: saved };
				}
			}
			catch (retryError) {
				console.warn('[config] 修复后重试仍然失败:', retryError);
			}
		}

		console.warn('保存配置失败:', e);
		return { success: false, config: current, error: errMsg };
	}
}

/**
 * 校验配置是否可用于AI请求
 */
export function validateConfig(config: ConfigStore): string | null {
	if (!config.apiKey || config.apiKey.trim().length === 0) {
		return 'API Key未配置';
	}
	if (!config.model || config.model.trim().length === 0) {
		return 'Model未配置';
	}
	if (!config.apiUrl || config.apiUrl.trim().length === 0) {
		return 'API URL未配置';
	}

	// MCP 启用时验证 Gateway URL
	if (config.mcpEnabled) {
		if (!config.mcpGatewayUrl || config.mcpGatewayUrl.trim().length === 0) {
			return 'MCP Gateway URL未配置';
		}
		try {
			const gatewayUrl = new URL(config.mcpGatewayUrl);
			if (gatewayUrl.protocol !== 'http:' && gatewayUrl.protocol !== 'https:') {
				return 'MCP Gateway URL必须是http或https协议';
			}
		}
		catch {
			return 'MCP Gateway URL格式无效';
		}
	}

	return null;
}

// ============ 对话历史 ============

/**
 * 加载对话历史记录
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
 * 保存对话历史记录
 */
export async function saveChatHistory(messages: unknown[]): Promise<{ success: boolean; error?: string }> {
	try {
		const success = await eda.sys_Storage.setExtensionUserConfig(HISTORY_KEY, messages);
		if (!success) {
			return { success: false, error: '存储写入失败' };
		}
		return { success: true };
	}
	catch (e) {
		const errMsg = e instanceof Error ? e.message : String(e);

		if (isStorageCorruptionError(e) && await repairStorageIfCorrupted()) {
			console.warn('[config] 存储污染导致历史记录保存失败，修复后重试');
			try {
				const retrySuccess = await eda.sys_Storage.setExtensionUserConfig(HISTORY_KEY, messages);
				if (retrySuccess) {
					return { success: true };
				}
			}
			catch (retryError) {
				console.warn('[config] 历史记录修复后重试仍然失败:', retryError);
			}
		}

		console.warn('保存历史记录失败:', e);
		return { success: false, error: errMsg };
	}
}

/**
 * 显示配置对话框
 */
export function showConfigDialog(): void {
	const config = loadConfig();

	// 使用简单的对话框提示用户配置
	eda.sys_Dialog.showInformationMessage(
		`当前配置：
Provider: ${config.provider}
Model: ${config.model}
API Key: ${config.apiKey ? '已配置' : '未配置'}

请在审查面板中点击"配置"按钮进行设置。`,
		'AI审查配置',
	);
}
