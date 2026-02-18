import type { ConfigStore } from './types';
/**
 * AI原理图审查 - 配置管理
 *
 * 使用localStorage持久化存储AI审查配置
 */
import { AIProvider } from './types';

const STORAGE_KEY = 'ai-sch-review-config';

/**
 * 默认配置
 */
const DEFAULT_CONFIG: ConfigStore = {
	provider: AIProvider.OPENAI,
	apiKey: '',
	model: 'gpt-4o',
	apiUrl: undefined,
	maxPinsPerChunk: 1200,
	timeout: 120,
};

/**
 * 从localStorage加载配置
 */
export function loadConfig(): ConfigStore {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) {
			return { ...DEFAULT_CONFIG };
		}
		const parsed = JSON.parse(raw) as Partial<ConfigStore>;
		return { ...DEFAULT_CONFIG, ...parsed };
	}
	catch {
		return { ...DEFAULT_CONFIG };
	}
}

/**
 * 保存配置到localStorage
 */
export function saveConfig(config: Partial<ConfigStore>): ConfigStore {
	const current = loadConfig();
	const merged: ConfigStore = { ...current, ...config };
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
	}
	catch {
		// localStorage可能不可用，静默失败
	}
	return merged;
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
	if (config.provider === AIProvider.OPENAI && !config.apiKey.startsWith('sk-')) {
		return 'OpenAI API Key格式可能不正确（应以sk-开头）';
	}
	return null;
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
