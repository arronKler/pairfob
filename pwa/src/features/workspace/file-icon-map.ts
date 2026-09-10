import type { FileIconId } from "./file-icon-glyphs";

function assign(target: Record<string, FileIconId>, id: FileIconId, keys: string): void {
  for (const key of keys.split(" ")) target[key] = id;
}

/** Exact basenames, lowercased. Name wins over extension so package.json is npm, not json. */
/**
 * Null-prototype maps: a legal filename such as "constructor", "toString" or
 * "__proto__" must not resolve to a prototype value. With a plain {} the
 * `map[name]` truthy lookup would return Object and then crash in the glyph
 * table. Null prototype keeps an unknown special name on the ordinary "file"
 * icon while preserving every exact mapping below.
 */
export const FILE_ICON_NAMES: Record<string, FileIconId> = Object.create(null);
assign(FILE_ICON_NAMES, "npm", "package.json package-lock.json .npmrc .nvmrc npm-shrinkwrap.json");
assign(FILE_ICON_NAMES, "lock", "yarn.lock pnpm-lock.yaml bun.lock bun.lockb cargo.lock gemfile.lock poetry.lock composer.lock");
assign(FILE_ICON_NAMES, "bun", "bunfig.toml");
assign(FILE_ICON_NAMES, "go", "go.mod go.sum");
assign(FILE_ICON_NAMES, "rs", "cargo.toml rust-toolchain rust-toolchain.toml");
assign(FILE_ICON_NAMES, "py", "pyproject.toml pipfile pipfile.lock requirements.txt setup.py setup.cfg tox.ini poetry.toml");
assign(FILE_ICON_NAMES, "rb", "gemfile rakefile config.ru");
assign(FILE_ICON_NAMES, "docker", "dockerfile .dockerignore");
assign(FILE_ICON_NAMES, "git", ".gitignore .gitattributes .gitmodules .gitkeep .keep");
assign(FILE_ICON_NAMES, "env", ".envrc .env.example .env.sample .env.template");
assign(FILE_ICON_NAMES, "config", [
  ".editorconfig .babelrc .babelrc.js babel.config.js babel.config.cjs babel.config.mjs",
  ".eslintrc .eslintrc.js .eslintrc.cjs .eslintrc.json .eslintrc.yml eslint.config.js eslint.config.mjs eslint.config.ts",
  ".prettierrc .prettierrc.js .prettierrc.cjs .prettierrc.json .prettierrc.yml prettier.config.js prettier.config.cjs prettier.config.mjs",
  ".stylelintrc .stylelintrc.json stylelint.config.js",
  "webpack.config.js webpack.config.ts rollup.config.js rollup.config.mjs",
  "vitest.config.ts vitest.config.js playwright.config.ts jest.config.js jest.config.ts",
  "wrangler.toml wrangler.json wrangler.jsonc wrangler.json5",
  "cmakelists.txt meson.build",
  ".clang-format .clang-tidy .pre-commit-config.yaml",
].join(" "));
assign(FILE_ICON_NAMES, "vite", "vite.config.ts vite.config.js vite.config.mjs vite.config.cjs");
assign(FILE_ICON_NAMES, "css", "tailwind.config.js tailwind.config.ts tailwind.config.cjs postcss.config.js postcss.config.cjs postcss.config.mjs");
assign(FILE_ICON_NAMES, "make", "makefile gnumakefile");
assign(FILE_ICON_NAMES, "license", "license license.md license.txt copying copying.md unlicense");
assign(FILE_ICON_NAMES, "md", "readme readme.md readme.txt changelog changelog.md contributing contributing.md");
assign(FILE_ICON_NAMES, "sh", ".bashrc .zshrc .zprofile .profile .bash_profile .bash_logout .zlogin .zshenv");
assign(FILE_ICON_NAMES, "graphql", ".graphqlrc .graphqlrc.yml .graphqlrc.yaml graphql.config.yml");
assign(FILE_ICON_NAMES, "terraform", ".terraform.lock.hcl");
assign(FILE_ICON_NAMES, "nix", "flake.nix flake.lock");
assign(FILE_ICON_NAMES, "php", "composer.json composer.lock");
assign(FILE_ICON_NAMES, "java", "pom.xml build.gradle build.gradle.kts settings.gradle settings.gradle.kts");
assign(FILE_ICON_NAMES, "swift", "package.swift");
assign(FILE_ICON_NAMES, "elixir", "mix.exs mix.lock");
assign(FILE_ICON_NAMES, "haskell", "stack.yaml cabal.project");
assign(FILE_ICON_NAMES, "proto", "buf.yaml buf.gen.yaml buf.lock");
assign(FILE_ICON_NAMES, "prisma", "schema.prisma");
assign(FILE_ICON_NAMES, "svelte", "svelte.config.js svelte.config.ts");
assign(FILE_ICON_NAMES, "vue", "nuxt.config.js nuxt.config.ts vue.config.js");
assign(FILE_ICON_NAMES, "astro", "astro.config.ts astro.config.mjs astro.config.js");
assign(FILE_ICON_NAMES, "react", "next.config.js next.config.mjs next.config.ts remix.config.js");
assign(FILE_ICON_NAMES, "image", "favicon.ico favicon.png apple-touch-icon.png");
assign(FILE_ICON_NAMES, "text", "authors authors.md codeowners security.md notice");

/** Dotted suffixes, lowercased, no leading dot. The resolver tries the longest remaining suffix first. */
export const FILE_ICON_EXTENSIONS: Record<string, FileIconId> = Object.create(null);
assign(FILE_ICON_EXTENSIONS, "js", "js mjs cjs es es6 coffee litcoffee");
assign(FILE_ICON_EXTENSIONS, "ts", "ts mts cts d.ts");
assign(FILE_ICON_EXTENSIONS, "react", "jsx tsx mtsx mjsx");
assign(FILE_ICON_EXTENSIONS, "json", "json jsonc json5 jsonl geojson webmanifest");
assign(FILE_ICON_EXTENSIONS, "html", "html htm xhtml ejs hbs mustache nunjucks njk pug jade twig liquid");
assign(FILE_ICON_EXTENSIONS, "css", "css pcss postcss styl stylus");
assign(FILE_ICON_EXTENSIONS, "sass", "scss sass");
assign(FILE_ICON_EXTENSIONS, "less", "less");
assign(FILE_ICON_EXTENSIONS, "md", "md markdown mdown mdx mdc");
assign(FILE_ICON_EXTENSIONS, "py", "py pyi pyw pyx pxd ipynb");
assign(FILE_ICON_EXTENSIONS, "go", "go");
assign(FILE_ICON_EXTENSIONS, "rs", "rs rlib");
assign(FILE_ICON_EXTENSIONS, "rb", "rb erb rake rbi");
assign(FILE_ICON_EXTENSIONS, "java", "java jar jmod gradle");
assign(FILE_ICON_EXTENSIONS, "c", "c h m");
assign(FILE_ICON_EXTENSIONS, "cpp", "cc cpp cxx c++ hh hpp hxx h++ mm");
assign(FILE_ICON_EXTENSIONS, "csharp", "cs csx");
assign(FILE_ICON_EXTENSIONS, "sh", "sh bash zsh fish ksh csh ps1 psm1 bat cmd command");
assign(FILE_ICON_EXTENSIONS, "sql", "sql sqlite sqlite3 db pgsql mysql");
assign(FILE_ICON_EXTENSIONS, "php", "php phtml php5 phar inc");
assign(FILE_ICON_EXTENSIONS, "swift", "swift");
assign(FILE_ICON_EXTENSIONS, "kt", "kt kts");
assign(FILE_ICON_EXTENSIONS, "dart", "dart");
assign(FILE_ICON_EXTENSIONS, "lua", "lua");
assign(FILE_ICON_EXTENSIONS, "vue", "vue");
assign(FILE_ICON_EXTENSIONS, "svelte", "svelte");
assign(FILE_ICON_EXTENSIONS, "astro", "astro");
assign(FILE_ICON_EXTENSIONS, "yaml", "yml yaml");
assign(FILE_ICON_EXTENSIONS, "toml", "toml");
assign(FILE_ICON_EXTENSIONS, "xml", "xml xsl xslt xsd dtd plist wsdl");
assign(FILE_ICON_EXTENSIONS, "svg", "svg svgz");
assign(FILE_ICON_EXTENSIONS, "image", "png jpg jpeg gif webp ico bmp avif tif tiff heic heif apng jfif");
assign(FILE_ICON_EXTENSIONS, "font", "ttf otf woff woff2 eot");
assign(FILE_ICON_EXTENSIONS, "pdf", "pdf");
assign(FILE_ICON_EXTENSIONS, "zip", "zip tar gz tgz rar 7z bz2 xz zst lz lz4 iso dmg pkg deb rpm apk");
assign(FILE_ICON_EXTENSIONS, "audio", "mp3 wav ogg flac aac m4a opus wma");
assign(FILE_ICON_EXTENSIONS, "video", "mp4 webm mov mkv avi m4v mpeg mpg");
assign(FILE_ICON_EXTENSIONS, "csv", "csv tsv");
assign(FILE_ICON_EXTENSIONS, "graphql", "graphql gql");
assign(FILE_ICON_EXTENSIONS, "proto", "proto pb");
assign(FILE_ICON_EXTENSIONS, "prisma", "prisma");
assign(FILE_ICON_EXTENSIONS, "terraform", "tf tfvars hcl");
assign(FILE_ICON_EXTENSIONS, "text", "txt log text rst adoc org nfo");
assign(FILE_ICON_EXTENSIONS, "binary", "exe dll so dylib o a bin dat pyc pyo obj lib");
assign(FILE_ICON_EXTENSIONS, "wasm", "wasm");
assign(FILE_ICON_EXTENSIONS, "elixir", "ex exs eex heex leex");
assign(FILE_ICON_EXTENSIONS, "haskell", "hs lhs cabal");
assign(FILE_ICON_EXTENSIONS, "scala", "scala sc sbt");
assign(FILE_ICON_EXTENSIONS, "r", "r rmd rproj");
assign(FILE_ICON_EXTENSIONS, "nix", "nix");
assign(FILE_ICON_EXTENSIONS, "zig", "zig zon");
assign(FILE_ICON_EXTENSIONS, "lock", "lock");
assign(FILE_ICON_EXTENSIONS, "env", "env");
assign(FILE_ICON_EXTENSIONS, "config", "ini cfg conf config properties editorconfig babelrc eslintrc prettierrc npmrc");
assign(FILE_ICON_EXTENSIONS, "make", "mk mak cmake");
assign(FILE_ICON_EXTENSIONS, "git", "gitignore gitattributes gitmodules");
assign(FILE_ICON_EXTENSIONS, "docker", "dockerfile");
