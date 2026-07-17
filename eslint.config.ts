import antfu from '@antfu/eslint-config'

export default antfu({
  ignores: ['examples/cloudflare/worker-configuration.d.ts'],
}).append({
  files: ['src/pdfjs-serverless/index.mjs'],
  rules: {
    'unused-imports/no-unused-imports': 'off',
  },
})
