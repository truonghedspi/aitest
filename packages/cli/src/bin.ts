#!/usr/bin/env -S npx tsx
import { formatError, main } from './index.ts'

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error) => {
    process.stderr.write(formatError(error) + '\n')
    process.exit(2)
  },
)
