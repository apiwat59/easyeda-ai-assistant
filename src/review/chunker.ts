/**
 * AI Schematic Review - chunking strategy module
 *
 * Split data by pin count to avoid oversized token usage in a single request
 */
import type { CollectedData, SchematicFieldsConfig, SchReviewChunk } from './types';
import { estimateJsonSize, serializeToCompactFormat } from './serializer';

/**
 * Chunk configuration
 */
export interface ChunkConfig {
	maxPinsPerChunk: number; // Default 1200
	maxBytesPerChunk: number; // Default 500 KB
}

const DEFAULT_CHUNK_CONFIG: ChunkConfig = {
	maxPinsPerChunk: 1200,
	maxBytesPerChunk: 500 * 1024,
};

/**
 * Split the data into chunks
 *
 * @param data    The collected source data
 * @param config  Chunk configuration with pin-count and byte-size limits
 * @param fields  Field selection configuration passed to the serializer to control which fields are visible to the AI
 */
export function chunkData(
	data: CollectedData,
	config: Partial<ChunkConfig> = {},
	fields?: SchematicFieldsConfig,
): SchReviewChunk[] {
	const cfg = { ...DEFAULT_CHUNK_CONFIG, ...config };

	// P2: Performance optimization - build a component-ID-to-pins map up front to avoid repeated filtering
	const componentPinsMap = new Map<string, typeof data.pins>();
	for (const pin of data.pins) {
		if (!componentPinsMap.has(pin.componentPrimitiveId)) {
			componentPinsMap.set(pin.componentPrimitiveId, []);
		}
		componentPinsMap.get(pin.componentPrimitiveId)!.push(pin);
	}

	// Sort components to guarantee deterministic output
	const sortedComponents = [...data.components].sort((a, b) => {
		// Sort by page UUID first
		if (a.schematicPageUuid !== b.schematicPageUuid) {
			return (a.schematicPageUuid || '').localeCompare(b.schematicPageUuid || '');
		}
		// Then sort by designator
		return a.designator.localeCompare(b.designator);
	});

	const chunks: SchReviewChunk[] = [];
	let currentChunkComponents: typeof sortedComponents = [];
	let currentChunkPinCount = 0;

	for (const component of sortedComponents) {
		// P2: Use the prebuilt map to avoid repeated filtering
		const componentPins = componentPinsMap.get(component.primitiveId) || [];
		const pinCount = componentPins.length;

		// Check whether a new chunk is needed
		if (
			currentChunkPinCount > 0
			&& currentChunkPinCount + pinCount > cfg.maxPinsPerChunk
		) {
			// Build the current chunk
			const chunk = buildChunk(
				data,
				currentChunkComponents,
				chunks.length,
				-1, // Total chunk count is not known yet
				fields,
			);

			// Enforce the byte limit using the same recursive split logic as the tail chunk
			const chunkSize = estimateJsonSize(chunk);
			if (chunkSize > cfg.maxBytesPerChunk) {
				console.warn(`Chunk ${chunks.length} exceeds byte limit: ${chunkSize} > ${cfg.maxBytesPerChunk}`);
				splitAndPushChunk(data, [...currentChunkComponents], chunks, cfg, fields);
			}
			else {
				chunks.push(chunk);
			}

			// The current chunk has been emitted; start collecting the next one
			currentChunkComponents = [];
			currentChunkPinCount = 0;
		}

		// Add the component to the current chunk
		currentChunkComponents.push(component);
		currentChunkPinCount += pinCount;
	}

	// Handle the final chunk, which may need recursive splitting to satisfy the byte limit
	splitAndPushChunk(data, currentChunkComponents, chunks, cfg, fields);

	// Update chunkCount on all chunks
	const totalChunks = chunks.length;
	for (let i = 0; i < chunks.length; i++) {
		chunks[i].summary.chunkCount = totalChunks;
		chunks[i].summary.chunkId = `chunk-${String(i + 1).padStart(2, '0')}`;
	}

	return chunks;
}

/**
 * Recursively split and push chunks so that each chunk satisfies the byte limit
 */
function splitAndPushChunk(
	data: CollectedData,
	components: typeof data.components,
	chunks: SchReviewChunk[],
	cfg: ChunkConfig,
	fields?: SchematicFieldsConfig,
): void {
	if (components.length === 0) {
		return;
	}

	const chunk = buildChunk(data, components, chunks.length, -1, fields);
	const chunkSize = estimateJsonSize(chunk);

	// The chunk fits the byte limit, or it contains only one component and cannot be split further
	if (chunkSize <= cfg.maxBytesPerChunk || components.length === 1) {
		chunks.push(chunk);
		return;
	}

	// Chunk exceeds the byte limit and contains multiple components: repeatedly pop until it fits
	const overflowComponents: typeof components = [];
	while (components.length > 1) {
		const lastComponent = components.pop();
		if (!lastComponent)
			break;
		overflowComponents.unshift(lastComponent);

		const reducedChunk = buildChunk(data, components, chunks.length, -1, fields);
		const reducedSize = estimateJsonSize(reducedChunk);

		if (reducedSize <= cfg.maxBytesPerChunk || components.length === 1) {
			// The remaining portion now fits, so emit it
			chunks.push(reducedChunk);
			// Recursively process the overflowed components
			splitAndPushChunk(data, overflowComponents, chunks, cfg, fields);
			return;
		}
	}
}

/**
 * Build a single chunk
 *
 * Global data such as texts, buses, and netLabels is attached only to the first chunk (chunkIndex === 0)
 * to avoid repeated transmission in multi-chunk scenarios.
 */
function buildChunk(
	data: CollectedData,
	components: typeof data.components,
	chunkIndex: number,
	totalChunks: number,
	fields?: SchematicFieldsConfig,
): SchReviewChunk {
	// Extract the set of component IDs in this chunk
	const componentIds = new Set(components.map(c => c.primitiveId));

	// Filter pins
	const chunkPins = data.pins.filter(p =>
		componentIds.has(p.componentPrimitiveId),
	);

	// Filter nets and keep only those that appear in this chunk
	const netNamesInChunk = new Set(
		chunkPins.map(p => p.netName).filter(Boolean) as string[],
	);
	const chunkNets = data.nets.filter(n => netNamesInChunk.has(n.netName));

	// Build chunk data. texts, buses, netLabels, graphic primitives, and global metadata are included only in the first chunk
	const chunkCollectedData: CollectedData = {
		components,
		pins: chunkPins,
		nets: chunkNets,
		netlistRaw: data.netlistRaw,
		timestamp: data.timestamp,
		...(chunkIndex === 0 && {
			texts: data.texts,
			buses: data.buses,
			netLabels: data.netLabels,
			arcs: data.arcs,
			circles: data.circles,
			polygons: data.polygons,
			rectangles: data.rectangles,
			primitivePins: data.primitivePins,
			drcResult: data.drcResult,
			projectInfo: data.projectInfo,
		}),
	};

	return serializeToCompactFormat(
		chunkCollectedData,
		`chunk-${String(chunkIndex + 1).padStart(2, '0')}`,
		totalChunks > 0 ? totalChunks : 1,
		fields,
	);
}
