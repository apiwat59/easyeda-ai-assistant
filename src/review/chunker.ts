/**
 * AI原理图审查 - 分块策略模块
 *
 * 按引脚数分块，避免单次请求Token过大
 */
import type { CollectedData, SchReviewChunk } from './types';
import { estimateJsonSize, serializeToCompactFormat } from './serializer';

/**
 * 分块配置
 */
export interface ChunkConfig {
	maxPinsPerChunk: number; // 默认1200
	maxBytesPerChunk: number; // 默认500KB
}

const DEFAULT_CHUNK_CONFIG: ChunkConfig = {
	maxPinsPerChunk: 1200,
	maxBytesPerChunk: 500 * 1024,
};

/**
 * 将数据分块
 */
export function chunkData(
	data: CollectedData,
	config: Partial<ChunkConfig> = {},
): SchReviewChunk[] {
	const cfg = { ...DEFAULT_CHUNK_CONFIG, ...config };

	// P2: 性能优化 - 预先构建器件ID到引脚的映射，避免重复过滤
	const componentPinsMap = new Map<string, typeof data.pins>();
	for (const pin of data.pins) {
		if (!componentPinsMap.has(pin.componentPrimitiveId)) {
			componentPinsMap.set(pin.componentPrimitiveId, []);
		}
		componentPinsMap.get(pin.componentPrimitiveId)!.push(pin);
	}

	// 按器件排序（保证可复现）
	const sortedComponents = [...data.components].sort((a, b) => {
		// 先按页UUID排序
		if (a.schematicPageUuid !== b.schematicPageUuid) {
			return (a.schematicPageUuid || '').localeCompare(b.schematicPageUuid || '');
		}
		// 再按位号排序
		return a.designator.localeCompare(b.designator);
	});

	const chunks: SchReviewChunk[] = [];
	let currentChunkComponents: typeof sortedComponents = [];
	let currentChunkPinCount = 0;

	for (const component of sortedComponents) {
		// P2: 使用预构建的映射，避免重复过滤
		const componentPins = componentPinsMap.get(component.primitiveId) || [];
		const pinCount = componentPins.length;

		// 检查是否需要新建分块
		if (
			currentChunkPinCount > 0
			&& currentChunkPinCount + pinCount > cfg.maxPinsPerChunk
		) {
			// 生成当前分块
			const chunk = buildChunk(
				data,
				currentChunkComponents,
				chunks.length,
				-1, // 暂时不知道总数
			);

			// P1: 强制执行字节限制
			const chunkSize = estimateJsonSize(chunk);
			let shouldResetChunk = true;

			if (chunkSize > cfg.maxBytesPerChunk) {
				console.warn(`Chunk ${chunks.length} exceeds byte limit: ${chunkSize} > ${cfg.maxBytesPerChunk}`);
				// 如果单个器件就超过限制，仍然需要添加（否则会死循环）
				if (currentChunkComponents.length === 1) {
					console.warn('Single component exceeds byte limit, adding anyway');
					chunks.push(chunk);
				}
				else {
					// 移除最后一个器件，重新生成分块
					const lastComponent = currentChunkComponents.pop();
					if (lastComponent) {
						const reducedChunk = buildChunk(
							data,
							currentChunkComponents,
							chunks.length,
							-1,
						);
						chunks.push(reducedChunk);

						// 将移除的器件作为新分块的起点
						const lastComponentPins = componentPinsMap.get(lastComponent.primitiveId) || [];
						currentChunkComponents = [lastComponent];
						currentChunkPinCount = lastComponentPins.length;

						// 不重置分块，让当前component加入到包含lastComponent的新分块中
						shouldResetChunk = false;
					}
				}
			}
			else {
				chunks.push(chunk);
			}

			// 只有在没有进行字节限制分裂时才重置
			if (shouldResetChunk) {
				currentChunkComponents = [];
				currentChunkPinCount = 0;
			}
		}

		// 添加到当前分块
		currentChunkComponents.push(component);
		currentChunkPinCount += pinCount;
	}

	// 处理最后一个分块（可能需要递归拆分以满足字节限制）
	splitAndPushChunk(data, currentChunkComponents, chunks, cfg);

	// 更新所有分块的chunkCount
	const totalChunks = chunks.length;
	for (let i = 0; i < chunks.length; i++) {
		chunks[i].summary.chunkCount = totalChunks;
		chunks[i].summary.chunkId = `chunk-${String(i + 1).padStart(2, '0')}`;
	}

	return chunks;
}

/**
 * 递归拆分并推送分块，确保每块都满足字节限制
 */
function splitAndPushChunk(
	data: CollectedData,
	components: typeof data.components,
	chunks: SchReviewChunk[],
	cfg: ChunkConfig,
): void {
	if (components.length === 0) {
		return;
	}

	const chunk = buildChunk(data, components, chunks.length, -1);
	const chunkSize = estimateJsonSize(chunk);

	// 满足字节限制，或只有一个器件（无法再拆分）
	if (chunkSize <= cfg.maxBytesPerChunk || components.length === 1) {
		chunks.push(chunk);
		return;
	}

	// 超过字节限制且有多个器件：反复pop直到满足限制
	const overflowComponents: typeof components = [];
	while (components.length > 1) {
		const lastComponent = components.pop();
		if (!lastComponent)
			break;
		overflowComponents.unshift(lastComponent);

		const reducedChunk = buildChunk(data, components, chunks.length, -1);
		const reducedSize = estimateJsonSize(reducedChunk);

		if (reducedSize <= cfg.maxBytesPerChunk || components.length === 1) {
			// 剩余部分满足限制，推送
			chunks.push(reducedChunk);
			// 递归处理溢出的器件
			splitAndPushChunk(data, overflowComponents, chunks, cfg);
			return;
		}
	}
}

/**
 * 构建单个分块
 */
function buildChunk(
	data: CollectedData,
	components: typeof data.components,
	chunkIndex: number,
	totalChunks: number,
): SchReviewChunk {
	// 提取该分块的器件ID集合
	const componentIds = new Set(components.map(c => c.primitiveId));

	// 过滤引脚
	const chunkPins = data.pins.filter(p =>
		componentIds.has(p.componentPrimitiveId),
	);

	// 过滤网络（只保留该分块中出现的网络）
	const netNamesInChunk = new Set(
		chunkPins.map(p => p.netName).filter(Boolean) as string[],
	);
	const chunkNets = data.nets.filter(n => netNamesInChunk.has(n.netName));

	// 构建分块数据
	const chunkData: CollectedData = {
		components,
		pins: chunkPins,
		nets: chunkNets,
		netlistRaw: data.netlistRaw,
		timestamp: data.timestamp,
	};

	return serializeToCompactFormat(
		chunkData,
		`chunk-${String(chunkIndex + 1).padStart(2, '0')}`,
		totalChunks > 0 ? totalChunks : 1,
	);
}
