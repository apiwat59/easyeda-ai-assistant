/**
 * AI原理图审查 - 流程编排器
 *
 * 串联完整审查流程：collect -> serialize -> chunk -> rule -> ai -> merge -> publish
 */
import type { ReviewIssue, ReviewResult, StatusMessage } from './types';
import { reviewChunkWithAI } from './ai-adapter';
import { chunkData } from './chunker';
import { collectSchematicData } from './collector';
import { loadConfig, validateConfig } from './config';
import { locateItems } from './locator';
import { runLocalRules } from './rule-engine';
import { ErrorCode, IssueSeverity, MESSAGE_TOPICS, ReviewError } from './types';

/**
 * MessageBus订阅任务引用（用于清理）
 */
let subscriptionTasks: Array<{ cancel: () => void }> = [];

/**
 * 运行原理图审查主流程
 */
export async function runSchematicReview(): Promise<void> {
	const config = loadConfig();

	// 打开IFrame面板
	try {
		await eda.sys_IFrame.openIFrame('/iframe/review.html', 900, 680, 'ai-sch-review');
	}
	catch {
		throw new ReviewError(
			ErrorCode.UI_IFRAME_FAILED,
			'无法打开审查面板',
		);
	}

	// 设置MessageBus监听（接收IFrame的定位请求）
	setupMessageBusListeners();

	try {
		// Step 1: 数据采集
		publishStatus({ status: 'collecting', message: '正在提取原理图数据...', progress: 10 });
		eda.sys_LoadingAndProgressBar.showProgressBar(5, eda.sys_I18n.text('Collecting schematic data...'));

		const collectedData = await collectSchematicData();

		eda.sys_LoadingAndProgressBar.showProgressBar(5, `已采集 ${collectedData.components.length} 个器件，${collectedData.pins.length} 个引脚`);

		// Step 2: 本地规则检查
		publishStatus({ status: 'collecting', message: '正在执行本地规则检查...', progress: 30 });
		eda.sys_LoadingAndProgressBar.showProgressBar(5, eda.sys_I18n.text('Running local rule checks...'));

		const localIssues = runLocalRules(collectedData);

		// Step 3: 分块
		const chunks = chunkData(collectedData, {
			maxPinsPerChunk: config.maxPinsPerChunk || 1200,
		});

		// Step 4: AI审查（如果配置了API Key）
		const aiIssues: ReviewIssue[] = [];
		const configError = validateConfig(config);

		if (!configError) {
			publishStatus({ status: 'analyzing', message: '正在发送给AI分析...', progress: 40 });
			eda.sys_LoadingAndProgressBar.showProgressBar(5, eda.sys_I18n.text('Sending to AI for analysis...'));

			const progressPerChunk = 50 / chunks.length;

			for (let i = 0; i < chunks.length; i++) {
				try {
					publishStatus({
						status: 'analyzing',
						message: `正在AI分析第 ${i + 1}/${chunks.length} 块...`,
						progress: 40 + progressPerChunk * i,
					});

					const aiResult = await reviewChunkWithAI(chunks[i], config);

					// 转换AI结果为ReviewIssue
					for (const item of aiResult.must_fix) {
						aiIssues.push(convertAIIssue(item, IssueSeverity.MUST_FIX, i));
					}
					for (const item of aiResult.suggestions) {
						aiIssues.push(convertAIIssue(item, IssueSeverity.SUGGESTION, i));
					}
				}
				catch (error) {
					console.error(`AI审查第 ${i + 1} 块失败:`, error);
					// AI审查失败不阻塞整个流程，继续处理其他分块
				}
			}
		}
		else {
			console.warn(`AI配置未完成: ${configError}，仅使用本地规则`);
		}

		// Step 5: 合并去重
		const allIssues = mergeAndDeduplicate(localIssues, aiIssues);

		// Step 6: 构建结果
		const result: ReviewResult = {
			must_fix: allIssues.filter(i => i.severity === IssueSeverity.MUST_FIX),
			suggestions: allIssues.filter(i => i.severity === IssueSeverity.SUGGESTION),
			metadata: {
				timestamp: Date.now(),
				totalComponents: collectedData.components.length,
				totalPins: collectedData.pins.length,
				totalNets: collectedData.nets.length,
				chunksProcessed: chunks.length,
				aiProvider: configError ? undefined : config.provider,
				aiModel: configError ? undefined : config.model,
			},
		};

		// Step 7: 发布结果到IFrame
		publishStatus({ status: 'complete', message: '分析完成', progress: 100 });
		publishData(result);

		eda.sys_LoadingAndProgressBar.showProgressBar(5, eda.sys_I18n.text('Review complete'));
		eda.sys_Dialog.showInformationMessage(
			`审查完成！发现 ${result.must_fix.length} 个必须修复的问题，${result.suggestions.length} 个建议。`,
			eda.sys_I18n.text('Review complete'),
		);
	}
	catch (error) {
		const message = error instanceof ReviewError ? error.message : String(error);
		publishStatus({ status: 'error', message });
		eda.sys_Dialog.showInformationMessage(
			`审查失败: ${message}`,
			eda.sys_I18n.text('Review failed'),
		);
	}
}

/**
 * 设置MessageBus监听
 */
function setupMessageBusListeners(): void {
	// 清理旧的订阅
	cleanupSubscriptions();

	// 监听定位请求
	const locateTask = eda.sys_MessageBus.subscribePublic(
		MESSAGE_TOPICS.LOCATE,
		(data: any) => {
			locateItems({
				components: data.components || [],
				pins: data.pins || [],
				nets: data.nets || [],
			});
		},
	);
	subscriptionTasks.push(locateTask);

	// 监听配置更新
	const configTask = eda.sys_MessageBus.subscribePublic(
		MESSAGE_TOPICS.CONFIG_UPDATE,
		async (data: any) => {
			const { saveConfig } = await import('./config');
			saveConfig(data);
		},
	);
	subscriptionTasks.push(configTask);

	// 监听URL打开请求
	const urlTask = eda.sys_MessageBus.subscribePublic(
		MESSAGE_TOPICS.OPEN_URL,
		(data: any) => {
			if (data.url) {
				// 通过系统浏览器打开URL
				window.open(data.url, '_blank');
			}
		},
	);
	subscriptionTasks.push(urlTask);
}

/**
 * 清理MessageBus订阅
 */
function cleanupSubscriptions(): void {
	for (const task of subscriptionTasks) {
		try {
			task.cancel();
		}
		catch {
			// 忽略清理错误
		}
	}
	subscriptionTasks = [];
}

/**
 * 发布状态消息
 */
function publishStatus(status: StatusMessage): void {
	try {
		eda.sys_MessageBus.publishPublic(MESSAGE_TOPICS.STATUS, status);
	}
	catch {
		console.warn('Failed to publish status');
	}
}

/**
 * 发布数据消息
 */
function publishData(result: ReviewResult): void {
	try {
		eda.sys_MessageBus.publishPublic(MESSAGE_TOPICS.DATA, {
			status: 'complete',
			result,
		});
	}
	catch {
		console.warn('Failed to publish data');
	}
}

/**
 * 转换AI问题为ReviewIssue
 */
function convertAIIssue(
	item: any,
	severity: IssueSeverity,
	chunkIndex: number,
): ReviewIssue {
	return {
		id: `ai-${severity}-${chunkIndex}-${Math.random().toString(36).substring(2, 8)}`,
		severity,
		title: item.title || '未知问题',
		reason: item.reason || '',
		impact: item.impact || '',
		confidence: item.confidence || 0.5,
		fix: item.fix || '',
		evidence: {
			components: item.evidence?.components || [],
			pins: item.evidence?.pins || [],
			nets: item.evidence?.nets || [],
			datasheet_urls: item.evidence?.datasheet_urls || [],
		},
		source: 'ai',
	};
}

/**
 * 合并去重本地规则和AI结果
 */
function mergeAndDeduplicate(
	localIssues: ReviewIssue[],
	aiIssues: ReviewIssue[],
): ReviewIssue[] {
	const merged: ReviewIssue[] = [...localIssues];

	for (const aiIssue of aiIssues) {
		// 检查是否与本地规则重复（通过比较evidence中的器件/引脚/网络）
		const isDuplicate = localIssues.some((localIssue) => {
			const localEvidence = localIssue.evidence;
			const aiEvidence = aiIssue.evidence;

			// 如果引用了相同的器件和引脚，认为是重复
			const sameComponents = localEvidence.components?.some(
				c => aiEvidence.components?.includes(c),
			);
			const samePins = localEvidence.pins?.some(
				p => aiEvidence.pins?.includes(p),
			);

			return sameComponents && samePins;
		});

		if (!isDuplicate) {
			merged.push(aiIssue);
		}
	}

	return merged;
}
