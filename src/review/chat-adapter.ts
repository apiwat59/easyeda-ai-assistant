/**
 * AI schematic review - AI communication adapter
 *
 * Core design:
 * 1. Do not use streaming transfer (the EDA API does not support a true ReadableStream)
 * 2. Request stream: false so the server returns standard JSON
 * 3. Receive the full response in one shot, then extract thinking and text content
 * 4. Simulate streaming events through the onBlock callback to keep the frontend experience consistent
 */

import type { CollectedData, ConfigStore, SchematicFieldsConfig, UserMessage } from './types';
import { chunkData } from './chunker';
import { buildChatSystemPrompt } from './prompt-builder';
import { extractReasoningFromDelta, getModelTemperature, getReasoningParams } from './reasoning-config';
import { ChunkType, ErrorCode, ReviewError } from './types';

/**
 * Debug log dispatch function (injected by the orchestrator)
 */
let debugLog: ((level: string, message: string, data?: any) => void) | null = null;

export function setDebugLog(fn: (level: string, message: string, data?: any) => void): void {
	debugLog = fn;
}

function logDebug(level: string, message: string, data?: any): void {
	// Send to the frontend debug panel
	if (debugLog) {
		debugLog(level, `[chat-adapter] ${message}`, data);
	}

	// Only warn/error are printed to the console
	if (level === 'warn') {
		console.warn(`[chat-adapter] ${message}`, data || '');
	}
	else if (level === 'error') {
		console.error(`[chat-adapter] ${message}`, data || '');
	}
}

/**
 * Message block handler (used to simulate a streaming experience)
 */
export type MessageBlockHandler = (block: {
	type: ChunkType;
	content: string;
	accumulatedContent: string;
	status?: 'success' | 'paused';
}) => void;

/**
 * sendMessage options
 */
export interface SendMessageOptions {
	tools?: import('./types').ChatToolDefinition[];
	onToolCalls?: (toolCalls: import('./types').ChatToolCall[]) => Promise<import('./types').ToolExecutionResultMessage[]>;
	maxToolRounds?: number;
}

/**
 * Chat completion result
 */
export interface ChatCompletionResult {
	textContent: string;
	reasoningContent: string;
	toolCalls: import('./types').ChatToolCall[];
}

/**
 * Chat message
 */
export interface ChatMessage {
	role: 'system' | 'user' | 'assistant' | 'tool';
	content: string | Array<{ type: string; text?: string; image_url?: { url: string } }> | null;
	tool_calls?: import('./types').ChatToolCall[];
	tool_call_id?: string;
	name?: string;
}

/**
 * Chat session class
 */
export class ChatSession {
	private history: ChatMessage[] = [];
	private schematicContext: string = '';
	private schematicFields?: SchematicFieldsConfig;

	constructor(schematicData?: CollectedData, schematicFields?: SchematicFieldsConfig) {
		this.schematicFields = schematicFields;
		if (schematicData) {
			const chunks = chunkData(schematicData, { maxPinsPerChunk: 1200 }, this.schematicFields);
			if (chunks.length > 0) {
				this.schematicContext = JSON.stringify(chunks[0]);
			}
		}
	}

	/**
	 * Build a data-update notice message (includes a data summary to help the AI confirm the data changed)
	 */
	private static buildDataUpdateNotice(data: CollectedData): string {
		return `[System Notice] The user modified the schematic and the data was collected again.

Latest data summary: ${data.components.length} components, ${data.pins.length} pins, ${data.nets.length} nets.

Important: the <schematic_data> block in the first system prompt of this conversation is now the latest version. Use it directly when answering questions. Do not rely on conclusions from previous turns, because components and connections may have changed.`;
	}

	private static buildDataUpdateAck(data: CollectedData): string {
		return `Understood. I confirm that the <schematic_data> block in the system prompt has been updated to the latest version (${data.components.length} components, ${data.pins.length} pins, ${data.nets.length} nets). I will answer follow-up questions by checking that data directly instead of relying on earlier conclusions.`;
	}

	/**
	 * Determine whether a message is a data-update notice (used by clear() to skip and deduplicate)
	 */
	private static isDataUpdateNotice(content: string | unknown): boolean {
		return typeof content === 'string' && content.startsWith('[System Notice] The user modified the schematic and the data was collected again.');
	}

	private static isDataUpdateAck(content: string | unknown): boolean {
		return typeof content === 'string' && content.startsWith('Understood. I confirm that the <schematic_data> block in the system prompt has been updated to the latest version');
	}

	/**
	 * Set the schematic context (used when updating data)
	 *
	 * When conversation history already exists, inject a user+assistant pair to notify the AI that the data changed.
	 * The notice includes a concrete data summary (component/pin/net counts) so the AI can confirm the data really changed,
	 * and explicitly tells the AI to look up data from the <schematic_data> block in the system prompt.
	 *
	 * Deduplication: setSchematicContext may be called repeatedly in succession (main collection + netlist refill),
	 * and if the tail already contains the notice pair it is replaced (because the summary may differ), preventing history bloat.
	 */
	setSchematicContext(data: CollectedData): void {
		this.updateSchematicContext(data);
		// If conversation history already exists, inject a data-update notice so the AI knows the data changed
		if (this.history.length > 0) {
			const len = this.history.length;

			// Deduplicate: if the tail is already a notice pair, replace it with the latest data summary (not skip it, because the counts may differ)
			if (
				len >= 2
				&& this.history[len - 2].role === 'user'
				&& ChatSession.isDataUpdateNotice(this.history[len - 2].content)
				&& this.history[len - 1].role === 'assistant'
				&& ChatSession.isDataUpdateAck(this.history[len - 1].content)
			) {
				this.history[len - 2].content = ChatSession.buildDataUpdateNotice(data);
				this.history[len - 1].content = ChatSession.buildDataUpdateAck(data);
				logDebug('info', '[setSchematicContext] Updated the summary in the trailing notice pair', {
					historyLength: len,
					components: data.components.length,
					pins: data.pins.length,
					nets: data.nets.length,
				});
				return;
			}

			this.history.push({
				role: 'user',
				content: ChatSession.buildDataUpdateNotice(data),
			});
			this.history.push({
				role: 'assistant',
				content: ChatSession.buildDataUpdateAck(data),
			});
			logDebug('info', '[setSchematicContext] Injected the data-update notice into history', {
				historyLength: this.history.length,
				components: data.components.length,
				pins: data.pins.length,
				nets: data.nets.length,
			});
		}
		else {
			logDebug('info', '[setSchematicContext] History is empty. Only schematicContext was updated (no notice injected)');
		}
	}

	/**
	 * Silently update the schematic context (do not inject a history notice; used to refresh after field configuration changes)
	 */
	updateSchematicContext(data: CollectedData): void {
		const chunks = chunkData(data, { maxPinsPerChunk: 1200 }, this.schematicFields);
		if (chunks.length > 0) {
			this.schematicContext = JSON.stringify(chunks[0]);
		}
	}

	/**
	 * Update the schematic field selection configuration
	 */
	updateSchematicFields(fields: SchematicFieldsConfig): void {
		this.schematicFields = fields;
	}

	/**
	 * Reset the session (clear history)
	 */
	reset(): void {
		this.history = [];
	}

	/**
	 * Send a user message and get the AI reply
	 *
	 * @param userMsg User message object
	 * @param config AI configuration
	 * @param onBlock Optional chunk callback for simulating a streaming experience (the actual send is one-shot)
	 * @param signal Optional AbortSignal for canceling the request
	 * @param options Optional tool-call options
	 */
	async sendMessage(
		userMsg: UserMessage,
		config: ConfigStore,
		onBlock?: MessageBlockHandler,
		signal?: AbortSignal,
		options?: SendMessageOptions,
	): Promise<string> {
		if (signal?.aborted) {
			throw createAbortReviewError('The request was canceled before sending', undefined, signal.reason);
		}

		const systemPrompt = buildChatSystemPrompt(this.schematicContext, config.customSystemPrompt);
		const customPromptTrimmed = typeof config.customSystemPrompt === 'string'
			? config.customSystemPrompt.trim()
			: '';
		if (customPromptTrimmed) {
			logDebug('info', '[sendMessage] Custom system prompt is enabled', {
				length: customPromptTrimmed.length,
			});
		}
		const initialHistoryLength = this.history.length;

		// Build the user message content
		const userContent = this.buildUserContent(userMsg);

		// Add the user message to history
		this.history.push({ role: 'user', content: userContent });

		const availableTools = options?.tools && options.tools.length > 0
			? options.tools
			: undefined;
		const warnToolRounds = Math.max(1, options?.maxToolRounds || 6);
		const hardLimitRounds = 20; // Prevent actual infinite loops

		try {
			let round = 1;
			while (true) {
				if (signal?.aborted) {
					throw createAbortReviewError('The request was canceled', undefined, signal.reason);
				}

				// Hard limit protection (prevents infinite loops)
				if (round > hardLimitRounds) {
					logDebug('warn', `Tool-call rounds reached the hard limit (${hardLimitRounds}). Forcing termination`, { round });
					throw new Error(`Tool-call rounds exceeded the hard limit (>${hardLimitRounds}), which may indicate a loop`);
				}

				// Soft warning (warn when exceeding the recommended number of rounds, but continue)
				if (round > warnToolRounds) {
					logDebug('warn', `Tool-call rounds exceeded the recommended limit (${warnToolRounds}). Current round: ${round}`, { round, warnToolRounds });
				}

				// Rebuild the messages from the latest history each round
				const messages: ChatMessage[] = [
					{ role: 'system', content: systemPrompt },
					...this.history,
				];

				const result = await callOpenAICompatibleChat(messages, config, signal, availableTools);

				logDebug('info', `[sendMessage] API returned in round ${round}`, {
					round,
					hasText: !!result.textContent,
					textLength: result.textContent.length,
					hasReasoning: !!result.reasoningContent,
					toolCallCount: result.toolCalls.length,
					historyLength: this.history.length,
				});

				// If the model requests tool calls, enter the tool-execution branch
				if (result.toolCalls.length > 0) {
					this.history.push({
						role: 'assistant',
						content: result.textContent || null,
						tool_calls: result.toolCalls,
					});

					if (!options?.onToolCalls) {
						// Fall back to a plain-text prompt when no tool executor is available to avoid a loop
						const fallbackText = result.textContent || 'The model requested a tool call, but tool execution is not enabled.';
						this.history.pop();
						this.history.push({
							role: 'assistant',
							content: fallbackText,
						});
						logDebug('info', '[sendMessage] No tool executor is available. Falling back to plain text (emitting complete blocks)', {
							round,
							fallbackTextLength: fallbackText.length,
						});
						emitCompleteBlocks(fallbackText, '', onBlock);
						return fallbackText;
					}

					const toolResults = await options.onToolCalls(result.toolCalls);
					if (!toolResults || toolResults.length === 0) {
						const firstCall = result.toolCalls[0];
						this.history.push({
							role: 'tool',
							tool_call_id: firstCall.id,
							name: firstCall.function.name,
							content: 'The tool executor did not return a result.',
						});
						round++;
						continue;
					}

					for (const toolResult of toolResults) {
						this.history.push({
							role: 'tool',
							tool_call_id: toolResult.toolCallId,
							name: toolResult.toolName,
							content: toolResult.content,
						});
					}
					round++;
					continue;
				}

				// Plain text response completed: only emit events to the UI here to avoid duplicate triggers during intermediate tool-call rounds
				logDebug('info', `[sendMessage] Final text response in round ${round}; emitting complete blocks`, {
					round,
					textLength: result.textContent.length,
					reasoningLength: result.reasoningContent.length,
					historyLength: this.history.length,
				});
				emitCompleteBlocks(result.textContent, result.reasoningContent, onBlock);

				const assistantContent = result.reasoningContent
					? `${result.reasoningContent}\n\n${result.textContent}`
					: result.textContent;
				this.history.push({ role: 'assistant', content: assistantContent });
				return result.textContent;
			}
		}
		catch (error) {
			// On error, roll back to the state before this request to avoid leaving behind partial tool messages
			this.history.splice(initialHistoryLength);
			throw error;
		}
	}

	/**
	 * Clear the last conversation turn (used for regeneration)
	 *
	 * In tool-call scenarios, a single turn may contain multiple messages:
	 *   user → assistant(tool_calls) → tool × N → assistant(final)
	 * Therefore, search backward from the end for the last user message and remove it and everything after it.
	 *
	 * Note: DATA_UPDATE_NOTICE (the data-update notice) is skipped because it is a pseudo user message automatically
	 * injected by setSchematicContext and does not belong to a real user Q&A turn. If it is not skipped and the tail
	 * happens to be a notice pair, clear() would remove only the notice pair while keeping the real previous turn,
	 * causing regeneration to fail.
	 */
	clear(): void {
		for (let i = this.history.length - 1; i >= 0; i--) {
			if (this.history[i].role === 'user') {
				// Only treat it as a pseudo message and skip it when this user message and the following assistant message form a complete notice pair
				if (ChatSession.isDataUpdateNotice(this.history[i].content)) {
					const next = this.history[i + 1];
					if (next?.role === 'assistant' && ChatSession.isDataUpdateAck(next.content)) {
						continue;
					}
				}
				this.history.splice(i);
				logDebug('info', '[clear] Rolled back the last conversation turn', {
					removedFromIndex: i,
					remainingHistoryLength: this.history.length,
				});
				return;
			}
		}
		logDebug('warn', '[clear] No real user message was found to roll back', {
			historyLength: this.history.length,
		});
	}

	/**
	 * Build user message content (supports text + images)
	 */
	private buildUserContent(userMsg: UserMessage): string | Array<{ type: string; text?: string; image_url?: { url: string } }> {
		// If there are no images, return the text directly
		if (!userMsg.images || userMsg.images.length === 0) {
			return userMsg.text || '';
		}

		// Use multipart format when images are present
		const parts: Array<{ type: string; text?: string; image_url?: { url: string } }> = [];

		for (const img of userMsg.images) {
			// img.data may be a full data URL (data:image/...;base64,...) or a plain base64 string
			const url = img.data.startsWith('data:')
				? img.data
				: `data:${img.type};base64,${img.data}`;
			parts.push({
				type: 'image_url',
				image_url: { url },
			});
		}

		if (userMsg.text) {
			parts.push({ type: 'text', text: userMsg.text });
		}

		return parts;
	}
}

// ============ Text normalization ============

function normalizeChunkText(text: unknown): string {
	if (typeof text !== 'string')
		return '';
	// Do not trim; preserve whitespace and newlines to avoid text concatenation
	return text;
}

// ============ AI API call ============

/**
 * Call the OpenAI-compatible Chat API
 */
async function callOpenAICompatibleChat(
	messages: ChatMessage[],
	config: ConfigStore,
	signal?: AbortSignal,
	tools?: import('./types').ChatToolDefinition[],
): Promise<ChatCompletionResult> {
	const url = config.apiUrl || 'https://api.openai.com/v1/chat/completions';

	const body: Record<string, unknown> = {
		model: config.model,
		messages: messages.map((m) => {
			const messageBody: Record<string, unknown> = {
				role: m.role,
				content: m.content,
			};

			if (m.tool_calls && m.tool_calls.length > 0) {
				messageBody.tool_calls = m.tool_calls;
			}
			if (m.tool_call_id) {
				messageBody.tool_call_id = m.tool_call_id;
			}
			if (m.name) {
				messageBody.name = m.name;
			}
			return messageBody;
		}),
		stream: true, // Streaming mode is required to obtain reasoning_content (for Grok and similar models)
		...getReasoningParams(config.model, 'medium'),
	};

	// temperature needs special handling: some models have hard constraints or do not accept this parameter
	const temperature = getModelTemperature(config.model, 'medium', 0.4);
	if (temperature !== undefined) {
		body.temperature = temperature;
	}

	if (tools && tools.length > 0) {
		body.tools = tools;
		body.tool_choice = 'auto';
	}

	return await makeRequest(url, config, body, signal);
}

/**
 * Send the HTTP request
 */
async function makeRequest(
	url: string,
	config: ConfigStore,
	body: unknown,
	signal?: AbortSignal,
): Promise<ChatCompletionResult> {
	let abortHandler: (() => void) | undefined;

	const abortPromise = signal
		? new Promise<never>((_, reject) => {
				const onAbort = (): void => {
					reject(createAbortReviewError('The request was canceled', url, signal.reason));
				};

				if (signal.aborted) {
					onAbort();
					return;
				}

				abortHandler = onAbort;
				signal.addEventListener('abort', onAbort, { once: true });
			})
		: undefined;

	try {
		const requestPromise = eda.sys_ClientUrl.request(
			url,
			'POST',
			JSON.stringify(body),
			{
				headers: {
					'Content-Type': 'application/json',
					'Authorization': `Bearer ${config.apiKey}`,
				},
			},
		) as Promise<unknown>;

		// Only user-initiated cancellation is supported; no timeout is set (some AI inference runs for a long time)
		const response = abortPromise
			? await Promise.race([requestPromise, abortPromise]) as Response
			: await requestPromise as Response;

		if (!response.ok) {
			const errorText = await response.text();
			logDebug('warn', 'AI HTTP request returned a non-success response', {
				url,
				status: response.status,
				bodyLength: coerceToString(errorText).length,
			});
			handleHttpError(response.status, errorText, url);
		}

		if (signal?.aborted) {
			throw createAbortReviewError('The request was canceled', url, signal.reason);
		}

		// Read the full response (the EDA API does not support true streaming transfer)
		let responseText = '';
		try {
			const rawResponseText = await response.text();
			// Defensive type conversion: ensure the value is a string
			responseText = coerceToString(rawResponseText);
			logDebug('info', 'response.text() succeeded', {
				url,
				textLength: responseText.length,
				textType: typeof rawResponseText,
			});
		}
		catch (error) {
			logDebug('error', 'response.text() failed', {
				url,
				error: error instanceof Error ? error.message : String(error),
			});
			throw new ReviewError(
				ErrorCode.AI_INVALID_RESPONSE,
				`Failed to read response content: ${error instanceof Error ? error.message : String(error)}`,
				{ url, originalError: serializeUnknownError(error) },
			);
		}

		if (signal?.aborted) {
			throw createAbortReviewError('The request was canceled', url, signal.reason);
		}

		// Check whether the response is SSE format
		const contentType = response.headers.get('content-type') || '';
		const isSSE = contentType.includes('text/event-stream')
			|| contentType.includes('text/plain')
			|| responseText.startsWith('data:')
			|| responseText.includes('\ndata:');

		logDebug('info', 'Response format detection', {
			contentType,
			isSSE,
			startsWithData: responseText.startsWith('data:'),
		});

		if (isSSE) {
			// SSE format: parse all events and accumulate reasoning and content
			return parseSSEResponse(responseText);
		}

		// Standard JSON response
		let data: any;
		try {
			data = JSON.parse(responseText);
		}
		catch (parseError) {
			logDebug('error', 'Failed to parse AI response JSON', {
				url,
				responseLength: responseText.length,
			});
			throw new ReviewError(
				ErrorCode.AI_INVALID_RESPONSE,
				'Failed to parse the AI response: the server returned non-JSON content',
				{
					url,
					responseBody: responseText.substring(0, 2000),
					parseError: serializeUnknownError(parseError),
				},
			);
		}

		// Extract text, reasoning, and tool_calls content
		const textContent = extractResponseText(data);
		const reasoningContent = extractReasoningText(data);
		const toolCalls = extractToolCalls(data);

		logDebug('info', 'Raw extraction result', {
			textLength: textContent.length,
			reasoningLength: reasoningContent.length,
			toolCallCount: toolCalls.length,
			hasThinkTag: /<think/i.test(textContent),
		});

		if (!textContent && !reasoningContent && toolCalls.length === 0) {
			throw new ReviewError(
				ErrorCode.AI_INVALID_RESPONSE,
				'The AI response contained neither content/reasoning_content nor tool_calls',
				{
					url,
					responseBody: JSON.stringify(data).substring(0, 2000),
				},
			);
		}

		// Extract <think> tags (if the AI included its thought process in content)
		const { finalText, extractedReasoning } = extractThinkTags(textContent);

		// Merge the extracted reasoning (prefer the non-whitespace reasoningContent)
		const finalReasoning = hasNonWhitespace(reasoningContent) ? reasoningContent : extractedReasoning;

		logDebug('info', 'Final extraction result', {
			finalTextLength: finalText.length,
			finalReasoningLength: finalReasoning.length,
			reasoningSource: hasNonWhitespace(reasoningContent) ? 'API field' : (extractedReasoning ? '<think> tag' : 'none'),
			toolCallCount: toolCalls.length,
		});

		return { textContent: finalText, reasoningContent: finalReasoning, toolCalls };
	}
	catch (error) {
		if (isAbortLikeError(error)) {
			throw createAbortReviewError('The request was canceled', url, signal?.reason);
		}

		if (error instanceof ReviewError) {
			throw error;
		}

		// Catch external interaction permission errors
		if (error instanceof Error) {
			const msg = error.message.toLowerCase();
			const permissionKeywords = [
				'external interaction permission',
				'external interaction',
				'external interaction',
				'permission denied',
				'access denied',
				'cors',
			];

			if (permissionKeywords.some(keyword => msg.includes(keyword.toLowerCase()))) {
				throw new ReviewError(
					ErrorCode.AI_NETWORK_ERROR,
					'External interaction permission is not enabled for this extension. Open the extension manager and enable "Allow external interaction".',
					{
						url,
						originalError: serializeUnknownError(error),
					},
				);
			}
		}

		throw new ReviewError(
			ErrorCode.AI_NETWORK_ERROR,
			`Network request failed: ${error instanceof Error ? error.message : String(error)}`,
			{
				url,
				originalError: serializeUnknownError(error),
			},
		);
	}
	finally {
		if (signal && abortHandler) {
			signal.removeEventListener('abort', abortHandler);
		}
	}
}

// ============ SSE parsing ============

/**
 * Parse an SSE response
 *
 * Strategy:
 * 1. Parse all SSE events and accumulate the full text and reasoning content
 * 2. Extract <think> tags if present
 * 3. Return the accumulated result (event emission is centrally controlled by sendMessage)
 */
function parseSSEResponse(text: string): ChatCompletionResult {
	// Defensive check
	if (!text || typeof text !== 'string') {
		logDebug('error', 'The SSE response is empty or malformed', {
			textType: typeof text,
			textValue: text,
		});
		throw new ReviewError(ErrorCode.AI_INVALID_RESPONSE, 'The SSE response is empty or malformed');
	}

	logDebug('info', 'Starting SSE response parsing', {
		textLength: text.length,
	});

	const lines = text.split(/\r?\n/);

	let textContent = '';
	let reasoningContent = '';
	const toolCallsBuffer = new Map<number, { id: string; name: string; argumentsText: string }>();
	let currentEventData: string[] = [];
	let parseErrorCount = 0;

	// First phase: parse all SSE events and accumulate content
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].trim();

		// A blank line indicates the end of an event
		if (line === '') {
			if (currentEventData.length > 0) {
				processEvent(currentEventData.join(''));
				currentEventData = [];
			}
			continue;
		}

		// Handle data: lines
		if (line.startsWith('data:')) {
			const dataContent = line.substring(5).trim();

			// Skip the [DONE] marker
			if (dataContent === '[DONE]') {
				if (currentEventData.length > 0) {
					processEvent(currentEventData.join(''));
					currentEventData = [];
				}
				continue;
			}

			currentEventData.push(dataContent);
		}
	}

	// Process the last event
	if (currentEventData.length > 0) {
		processEvent(currentEventData.join(''));
	}

	// Parse a single SSE event
	function processEvent(eventText: string): void {
		try {
			const chunk = JSON.parse(eventText);
			const delta = chunk?.choices?.[0]?.delta;
			if (!delta)
				return;

			// Accumulate tool_calls deltas from the SSE stream
			appendSseToolCalls(delta.tool_calls, toolCallsBuffer);

			// 🆕 Use the unified reasoning extraction function (supports all models)
			const reasoning = normalizeChunkText(extractReasoningFromDelta(delta));
			const content = normalizeChunkText(delta.content);

			if (reasoning) {
				reasoningContent += reasoning;
			}
			if (content) {
				textContent += content;
			}
		}
		catch {
			// Ignore parsing errors for individual events
			parseErrorCount++;
		}
	}

	logDebug('info', 'SSE parsing completed (accumulation phase)', {
		textLength: textContent.length,
		reasoningLength: reasoningContent.length,
	});

	if (parseErrorCount > 0) {
		logDebug('warn', 'Some SSE event fragments failed to parse', { parseErrorCount });
	}

	// Second phase: extract tags
	if (!reasoningContent && textContent) {
		// Extract <think> tags (greedy match to ensure the full content is captured)
		const thinkTagRegex = /<think>[\s\S]*<\/think>|<thought>[\s\S]*<\/thought>|<thinking>[\s\S]*<\/thinking>/gi;
		const thinkMatches = textContent.match(thinkTagRegex);
		if (thinkMatches && thinkMatches.length > 0) {
			reasoningContent = thinkMatches.map((match) => {
				return match.replace(/<\/?(?:think|thought|thinking)>/gi, '').trim();
			}).join('\n\n');
			textContent = textContent.replace(thinkTagRegex, '').trim();
			logDebug('info', 'Extracted reasoning from the <think> tag', {
				extractedLength: reasoningContent.length,
				matchCount: thinkMatches.length,
			});
		}
		else {
			logDebug('warn', 'A complete <think> tag was not found', {
				hasOpenTag: textContent.includes('<think>'),
				hasCloseTag: textContent.includes('</think>'),
			});
		}
	}

	logDebug('info', 'Final SSE extraction result', {
		textLength: textContent.length,
		reasoningLength: reasoningContent.length,
		toolCallCount: toolCallsBuffer.size,
		reasoningSource: reasoningContent ? 'SSE delta' : 'none',
	});

	const toolCalls = buildToolCallsFromBuffer(toolCallsBuffer);

	if (!textContent && !reasoningContent && toolCalls.length === 0) {
		throw new ReviewError(ErrorCode.AI_INVALID_RESPONSE, 'Failed to extract content from the SSE response');
	}

	return { textContent, reasoningContent, toolCalls };
}

// ============ Helper functions ============

/**
 * Extract <think> tags from text
 */
function extractThinkTags(text: string): { finalText: string; extractedReasoning: string } {
	if (!text) {
		return { finalText: '', extractedReasoning: '' };
	}

	// Extract <think> tags
	const thinkTagRegex = /<think>[\s\S]*?<\/think>|<thought>[\s\S]*?<\/thought>|<thinking>[\s\S]*?<\/thinking>/gi;
	const thinkMatches = text.match(thinkTagRegex);

	if (thinkMatches && thinkMatches.length > 0) {
		const extractedReasoning = thinkMatches.map((match) => {
			return match.replace(/<\/?(?:think|thought|thinking)>/gi, '').trim();
		}).join('\n\n');
		const finalText = text.replace(thinkTagRegex, '').trim();
		return { finalText, extractedReasoning };
	}

	// Extract Grok format
	const hasGrokMarkers = /\[(?:Agent\s+\d+|Grok)\]\[/.test(text) || /browse_page\s*\{/.test(text);
	if (hasGrokMarkers) {
		const contentLines = text.split('\n');
		const thinkingLines: string[] = [];
		const textLines: string[] = [];

		for (const line of contentLines) {
			const trimmed = line.trim();
			if (trimmed.match(/^\[(?:Agent\s+\d+|Grok)\]\[/) || trimmed.startsWith('browse_page')) {
				thinkingLines.push(line);
			}
			else if (trimmed.length > 0) {
				textLines.push(line);
			}
		}

		if (thinkingLines.length > 0) {
			return {
				finalText: textLines.join('\n').trim(),
				extractedReasoning: thinkingLines.join('\n').trim(),
			};
		}
	}

	return { finalText: text, extractedReasoning: '' };
}

function emitCompleteBlocks(
	textContent: string,
	reasoningContent: string,
	onBlock?: MessageBlockHandler,
): void {
	if (!onBlock) {
		logDebug('debug', 'onBlock callback is empty; skipping event emission');
		return;
	}

	logDebug('debug', 'Preparing to emit events', {
		hasReasoning: !!reasoningContent,
		hasText: !!textContent,
		reasoningLength: reasoningContent.length,
		textLength: textContent.length,
	});

	if (reasoningContent) {
		logDebug('debug', 'Emitting THINKING events', { length: reasoningContent.length });
		onBlock({ type: ChunkType.THINKING_START, content: '', accumulatedContent: '' });
		onBlock({ type: ChunkType.THINKING_DELTA, content: reasoningContent, accumulatedContent: reasoningContent });
		onBlock({ type: ChunkType.THINKING_COMPLETE, content: '', accumulatedContent: reasoningContent, status: 'success' });
	}
	else {
		logDebug('debug', 'No reasoning content; skipping THINKING events');
	}

	if (textContent) {
		logDebug('debug', 'Emitting TEXT events', { length: textContent.length });
		onBlock({ type: ChunkType.TEXT_START, content: '', accumulatedContent: '' });
		onBlock({ type: ChunkType.TEXT_DELTA, content: textContent, accumulatedContent: textContent });
		onBlock({ type: ChunkType.TEXT_COMPLETE, content: '', accumulatedContent: textContent, status: 'success' });
	}
	else {
		logDebug('debug', 'No text content; skipping TEXT events');
	}
}

function extractResponseText(data: any): string {
	return normalizeChunkText(
		data.choices?.[0]?.message?.content
		|| data.choices?.[0]?.text
		|| data.content,
	);
}

function extractReasoningText(data: any): string {
	return normalizeChunkText(
		data.choices?.[0]?.message?.reasoning_content
		|| data.choices?.[0]?.message?.reasoning
		|| data.choices?.[0]?.reasoning_content,
	);
}

function extractToolCalls(data: any): import('./types').ChatToolCall[] {
	return normalizeToolCalls(data?.choices?.[0]?.message?.tool_calls);
}

function createAbortReviewError(message: string, url?: string, reason?: unknown): ReviewError {
	return new ReviewError(
		ErrorCode.AI_ABORTED,
		message,
		{
			aborted: true,
			url,
			reason: reason === undefined ? undefined : serializeUnknownError(reason),
		},
	);
}

function isAbortLikeError(error: unknown): boolean {
	if (error instanceof ReviewError && error.code === ErrorCode.AI_ABORTED) {
		return true;
	}
	if (error instanceof Error) {
		const msg = error.message.toLowerCase();
		return msg.includes('abort') || msg.includes('cancel');
	}
	return false;
}

function serializeUnknownError(error: unknown): any {
	if (error instanceof Error) {
		return {
			name: error.name,
			message: error.message,
			stack: error.stack,
		};
	}
	return String(error);
}

function handleHttpError(status: number, errorText: unknown, url: string): never {
	let errorMessage = `HTTP ${status}`;
	let errorCode = ErrorCode.AI_NETWORK_ERROR;

	if (status === 401 || status === 403) {
		errorMessage = 'The API key is invalid or does not have permission';
		errorCode = ErrorCode.AI_AUTH_ERROR;
	}
	else if (status === 429) {
		errorMessage = 'The API rate limit was exceeded. Please retry later';
		errorCode = ErrorCode.AI_RATE_LIMIT;
	}
	else if (status >= 500) {
		errorMessage = 'The AI service is temporarily unavailable';
		errorCode = ErrorCode.AI_SERVER_ERROR;
	}

	throw new ReviewError(
		errorCode,
		errorMessage,
		{
			url,
			status,
			responseBody: coerceToString(errorText).substring(0, 500),
		},
	);
}

/**
 * Check whether a string contains any non-whitespace characters
 */
function hasNonWhitespace(text: string): boolean {
	return text.trim().length > 0;
}

/**
 * Force-convert an unknown type to a string
 */
function coerceToString(value: unknown): string {
	if (typeof value === 'string') {
		return value;
	}
	if (value === null || value === undefined) {
		return '';
	}
	if (typeof value === 'object') {
		try {
			return JSON.stringify(value);
		}
		catch {
			return String(value);
		}
	}
	return String(value);
}

// ============ Tool Calls helper functions ============

function normalizeToolCalls(rawToolCalls: unknown): import('./types').ChatToolCall[] {
	if (!Array.isArray(rawToolCalls)) {
		return [];
	}

	const calls: import('./types').ChatToolCall[] = [];
	for (let i = 0; i < rawToolCalls.length; i++) {
		const rawCall = rawToolCalls[i];
		if (!isRecord(rawCall))
			continue;
		if (rawCall.type !== 'function')
			continue;

		const rawFunction = isRecord(rawCall.function) ? rawCall.function : null;
		const name = rawFunction && typeof rawFunction.name === 'string'
			? rawFunction.name
			: '';
		if (!name)
			continue;

		const argumentsText = rawFunction && typeof rawFunction.arguments === 'string'
			? rawFunction.arguments
			: '{}';
		const id = typeof rawCall.id === 'string' && rawCall.id
			? rawCall.id
			: `tool_call_${i + 1}`;

		calls.push({
			id,
			type: 'function',
			function: {
				name,
				arguments: argumentsText,
			},
		});
	}
	return calls;
}

function appendSseToolCalls(
	rawDeltaToolCalls: unknown,
	buffer: Map<number, { id: string; name: string; argumentsText: string }>,
): void {
	if (!Array.isArray(rawDeltaToolCalls)) {
		return;
	}

	for (let i = 0; i < rawDeltaToolCalls.length; i++) {
		const rawToolCall = rawDeltaToolCalls[i];
		if (!isRecord(rawToolCall))
			continue;

		const index = typeof rawToolCall.index === 'number'
			? rawToolCall.index
			: i;
		const existing = buffer.get(index) || {
			id: '',
			name: '',
			argumentsText: '',
		};

		if (typeof rawToolCall.id === 'string' && rawToolCall.id) {
			existing.id = rawToolCall.id;
		}

		const rawFunction = isRecord(rawToolCall.function) ? rawToolCall.function : null;
		if (rawFunction) {
			if (typeof rawFunction.name === 'string' && rawFunction.name) {
				existing.name = rawFunction.name;
			}
			if (typeof rawFunction.arguments === 'string') {
				existing.argumentsText += rawFunction.arguments;
			}
		}

		buffer.set(index, existing);
	}
}

function buildToolCallsFromBuffer(buffer: Map<number, { id: string; name: string; argumentsText: string }>): import('./types').ChatToolCall[] {
	const calls: import('./types').ChatToolCall[] = [];
	const entries = Array.from(buffer.entries()).sort((a, b) => a[0] - b[0]);

	for (const [index, value] of entries) {
		if (!value.name) {
			continue;
		}
		calls.push({
			id: value.id || `tool_call_${index + 1}`,
			type: 'function',
			function: {
				name: value.name,
				arguments: value.argumentsText || '{}',
			},
		});
	}

	return calls;
}

function isRecord(value: unknown): value is Record<string, any> {
	return typeof value === 'object' && value !== null;
}
