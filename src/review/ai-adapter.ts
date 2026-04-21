/**
 * AI schematic review - AI communication adapter
 *
 * Wraps OpenAI-compatible API communication, including CORS and retry handling.
 */
import type { ConfigStore, SchReviewChunk } from './types';
import { buildSystemPrompt, buildUserPrompt } from './prompt-builder';
import { getModelTemperature } from './reasoning-config';
import { ErrorCode, ReviewError } from './types';

/**
 * Parsed AI response format.
 */
interface AIResponse {
	must_fix: Array<{
		title: string;
		reason: string;
		impact: string;
		confidence: number;
		fix: string;
		evidence: {
			components?: string[];
			pins?: string[];
			nets?: string[];
			datasheet_urls?: string[];
		};
	}>;
	suggestions: Array<{
		title: string;
		reason: string;
		impact: string;
		confidence: number;
		fix: string;
		evidence: {
			components?: string[];
			pins?: string[];
			nets?: string[];
			datasheet_urls?: string[];
		};
	}>;
}

/**
 * Send a schematic chunk to the AI for review.
 */
export async function reviewChunkWithAI(
	chunk: SchReviewChunk,
	config: ConfigStore,
): Promise<AIResponse> {
	const systemPrompt = buildSystemPrompt();
	const userPrompt = buildUserPrompt(chunk);

	return await callOpenAICompatible(systemPrompt, userPrompt, config);
}

/**
 * Call an OpenAI-compatible API endpoint.
 */
async function callOpenAICompatible(
	systemPrompt: string,
	userPrompt: string,
	config: ConfigStore,
): Promise<AIResponse> {
	const url = config.apiUrl || 'https://api.openai.com/v1/chat/completions';

	const body: Record<string, unknown> = {
		model: config.model,
		messages: [
			{ role: 'system', content: systemPrompt },
			{ role: 'user', content: userPrompt },
		],
		response_format: { type: 'json_object' },
	};

	// Temperature requires special handling for some model families.
	const temperature = getModelTemperature(config.model, 'none', 0.3);
	if (temperature !== undefined) {
		body.temperature = temperature;
	}

	return await makeRequest(url, config.apiKey, body);
}

/**
 * Send an HTTP request with retry handling.
 */
async function makeRequest(
	url: string,
	apiKey: string,
	body: unknown,
): Promise<AIResponse> {
	const maxRetries = 3;
	let lastError: Error | null = null;

	for (let attempt = 1; attempt <= maxRetries; attempt++) {
		try {
			const response = await eda.sys_ClientUrl.request(
				url,
				'POST',
				JSON.stringify(body),
				{
					headers: {
						'Content-Type': 'application/json',
						'Authorization': `Bearer ${apiKey}`,
					},
				},
			);

			if (!response.ok) {
				const errorText = await response.text();
				throw new Error(`HTTP ${response.status}: ${errorText}`);
			}

			const data = await response.json();
			return parseAIResponse(data);
		}
		catch (error) {
			// `ReviewError` should pass through directly and must not be swallowed by retry logic.
			if (error instanceof ReviewError) {
				throw error;
			}

			lastError = error instanceof Error ? error : new Error(String(error));

			if (lastError.message.includes('401') || lastError.message.includes('403')) {
				throw new ReviewError(
					ErrorCode.AI_AUTH_ERROR,
					'The API key is invalid or does not have permission',
					lastError,
				);
			}

			if (lastError.message.includes('429')) {
				throw new ReviewError(
					ErrorCode.AI_RATE_LIMIT,
					'The API rate limit was exceeded',
					lastError,
				);
			}

			if (lastError.message.includes('CORS')) {
				throw new ReviewError(
					ErrorCode.AI_CORS_ERROR,
					'CORS error. Check the API URL or use a proxy',
					lastError,
				);
			}

			if (attempt === maxRetries) {
				throw new ReviewError(
					ErrorCode.AI_NETWORK_ERROR,
					`Network request failed after ${maxRetries} attempts: ${lastError.message}`,
					lastError,
				);
			}

			await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
		}
	}

	throw new ReviewError(
		ErrorCode.AI_NETWORK_ERROR,
		'Network request failed',
		lastError,
	);
}

/**
 * Parse the AI response.
 */
function parseAIResponse(data: any): AIResponse {
	try {
		let contentText = '';

		if (data.choices && data.choices[0]?.message?.content) {
			contentText = data.choices[0].message.content;
		}
		else {
			throw new Error('Unable to parse the AI response format');
		}

		contentText = contentText.trim();
		if (contentText.startsWith('```json')) {
			contentText = contentText.replace(/^```json\s*/, '').replace(/```\s*$/, '');
		}
		else if (contentText.startsWith('```')) {
			contentText = contentText.replace(/^```\s*/, '').replace(/```\s*$/, '');
		}

		const content = JSON.parse(contentText);
		return normalizeResponse(content);
	}
	catch (error) {
		throw new ReviewError(
			ErrorCode.AI_INVALID_RESPONSE,
			`Invalid AI response format: ${error instanceof Error ? error.message : String(error)}`,
			data,
		);
	}
}

/**
 * Normalize the AI response structure.
 */
function normalizeResponse(content: any): AIResponse {
	return {
		must_fix: Array.isArray(content.must_fix) ? content.must_fix : [],
		suggestions: Array.isArray(content.suggestions) ? content.suggestions : [],
	};
}
