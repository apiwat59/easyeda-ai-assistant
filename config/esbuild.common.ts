import type esbuild from 'esbuild';

export default {
	entryPoints: {
		index: './src/index',
	},
	entryNames: '[name]',
	assetNames: '[name]',
	bundle: true, // Used by internal method calls. Do not change.
	minify: false, // Used by internal method calls. Do not change.
	loader: {},
	outdir: './dist/',
	sourcemap: undefined,
	platform: 'browser', // Used by internal method calls. Do not change.
	format: 'iife', // Used by internal method calls. Do not change.
	globalName: 'edaEsbuildExportName', // Used by internal method calls. Do not change.
	treeShaking: true,
	ignoreAnnotations: true,
	define: {},
	external: [],
} satisfies Parameters<(typeof esbuild)['build']>[0];
