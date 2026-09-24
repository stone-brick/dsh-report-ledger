# Third-party notices

This package ships a **built** host half (`lib/index.js`) that inlines its only
third-party runtime dependency, as explained in `tsdown.config.ts`: a plugin
installed into a DSH profile cannot rely on the profile's transitive module
resolution, so a non-harness dependency must be bundled.

## yaml

- Package: `yaml` (https://github.com/eemeli/yaml)
- Version bundled: 2.9.1
- License: ISC
- Used for: reading and writing the ledger's front matter and transfer-path files.

```
Copyright Eemeli Aro <eemeli@gmail.com>

Permission to use, copy, modify, and/or distribute this software for any purpose
with or without fee is hereby granted, provided that the above copyright notice
and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND
FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS
OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER
TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF
THIS SOFTWARE.
```

Everything else imported at runtime — `@deepseek-ai/cordis`,
`@deepseek-ai/dsh-tools`, and the browser platform modules (`react`,
`react/jsx-runtime`) — is supplied by the DSH host or the DSH web shell and is
never bundled.
