/**
 * AI 原理图助手 - 扩展入口
 */
import { showConfigDialog } from './review/config';
import { isCollectionInProgress, startAIChat, triggerBackgroundCollection } from './review/orchestrator';

const AUTO_COLLECT_TIMER_ID = 'ai-sch-auto-collect';
const AUTO_COLLECT_INTERVAL_MS = 5000;

let autoCollectorInitialized = false;
let lastObservedSchematicUuid: string | null = null;

/**
 * 扩展激活入口：初始化后台采集定时监控
 */
export function activate(status?: 'onStartupFinished', arg?: string): void {
	void status;
	void arg;

	if (autoCollectorInitialized) {
		return;
	}
	autoCollectorInitialized = true;

	// 防御式清理，避免重复注册同名定时器
	try {
		eda.sys_Timer.clearIntervalTimer(AUTO_COLLECT_TIMER_ID);
	}
	catch {
		// ignore
	}

	// 启动定时器：每5秒检测文档变化
	eda.sys_Timer.setIntervalTimer(
		AUTO_COLLECT_TIMER_ID,
		AUTO_COLLECT_INTERVAL_MS,
		() => {
			void probeDocumentAndTriggerCollection();
		},
	);

	// 立即执行一次，不等待第一个 5s 周期
	void probeDocumentAndTriggerCollection();
}

/**
 * 检测当前文档变化并触发后台采集
 */
async function probeDocumentAndTriggerCollection(): Promise<void> {
	try {
		// 如果正在采集中，跳过本次检测（避免被逐页采集的内部切页干扰）
		if (isCollectionInProgress()) {
			return;
		}

		const docInfo = await eda.dmt_SelectControl.getCurrentDocumentInfo();
		if (!docInfo || docInfo.documentType !== 1 || !docInfo.uuid) {
			// 不是原理图文档或无效文档
			lastObservedSchematicUuid = null;
			return;
		}
		if (lastObservedSchematicUuid === docInfo.uuid) {
			// 文档未变化，跳过采集
			return;
		}
		lastObservedSchematicUuid = docInfo.uuid;
		// 触发后台采集（不通知 IFrame，因为可能没有打开对话面板）
		void triggerBackgroundCollection(`doc-change:${docInfo.uuid}`, false);
	}
	catch (error) {
		console.warn('后台文档变化检测失败:', error);
	}
}

/**
 * AI原理图对话助手入口
 */
export function aiSchematicReview(): void {
	startAIChat().catch((error) => {
		const message = error instanceof Error ? error.message : String(error);
		console.error('AI Chat failed:', error);
		try {
			eda.sys_Dialog.showInformationMessage(
				`AI助手启动失败: ${message}`,
				'启动失败',
			);
		}
		catch {
			// Dialog调用失败时静默降级
		}
	});
}

/**
 * AI配置入口
 */
export function aiReviewConfig(): void {
	showConfigDialog();
}
