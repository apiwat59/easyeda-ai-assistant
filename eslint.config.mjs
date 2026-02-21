import antfu from '@antfu/eslint-config';

export default antfu({
	stylistic: {
		indent: 'tab',
		quotes: 'single',
		semi: true,
	},

	typescript: true,

	ignores: [
		'build/**',
		'dist/**',
		'coverage/**',
		'node_modules/**',
		'.eslintcache',
		'debug.log',
		'**/*.md',
		'**/*.html',
		'iframe/vendor/**',
		'docs/**',
	],
});
