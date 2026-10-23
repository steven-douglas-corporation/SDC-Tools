# Fonts

`Montserrat-latin-wght.woff2` is Montserrat's variable font (weights 400–700), latin subset, copied from
Google Fonts (`fonts.gstatic.com/s/montserrat/v31/`). Montserrat is licensed under the SIL Open Font License
1.1 (https://openfontlicense.org), which allows bundling it with the app.

It is loaded by `src/app/layout.tsx` with `next/font/local`. It used to come from `next/font/google`, which
downloads the font at **build** time; when the CI runner could not reach Google Fonts the whole
`next build` failed with a wall of `module-not-found` lines from Next's font loader. A bundled copy removes
that dependency on the network. Same font, same weights, same `--font-montserrat` variable.

To update it, fetch the `/* latin */` file from
`https://fonts.googleapis.com/css2?family=Montserrat:wght@400..700` and replace this one.
