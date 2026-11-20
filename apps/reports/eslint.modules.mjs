// Module boundaries, checked by lint.
//
// A module is a folder under src/modules (see docs/MODULES.md). Each one keeps to itself:
//
//   - Only its service/ folder runs SQL. Components never import a database connection.
//   - Its service/ takes the database as an argument and imports nothing from Next.js or React,
//     so tests can run it directly.
//   - Its pure logic (forecast/, pure/) imports nothing from the app, the database or a framework.
//   - Its pages, actions and API routes hand the connection to a service function; they never
//     call .query() or .transaction() themselves.
//   - One module may call another module's service functions and nothing else of it.
//   - The rest of the app reaches a module through its pages and API only.
//
// The rules apply to every folder under src/modules, found when lint runs, so a new module is
// covered without touching this file. With no src/modules folder they add nothing.
//
// Built-in rules only (no-restricted-imports, no-restricted-syntax): no new dependency.
// ESLint keeps only the LAST block that sets a rule for a file. So a later block in
// eslint.config.mjs that sets either rule for these files replaces these bans instead of adding
// to them, and inside this file the cross-module bans are repeated in every block.
import { existsSync, readdirSync } from "node:fs";

const root = new URL("./src/modules", import.meta.url);
const modules = existsSync(root)
  ? readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
  : [];

// A broken boundary is a design fault, not hygiene, and CI stops on errors only.
const LEVEL = "error";

/** One no-restricted-imports entry: these import paths, and the sentence shown for them. */
const ban = (group, message) => ({ group, message });

const DB = (m) => [`@/modules/${m}/db`, "**/db", "./db", "../db"];
const FRAMEWORK = ["next", "next/*", "react", "react-dom", "react-dom/*"];
const DRIVER = ["pg", "pg/*", "@prisma/client", "@/lib/prisma", "@/lib/db"];

const perModule = modules.flatMap((m) => {
  const own = `src/modules/${m}`;
  const cross = modules
    .filter((o) => o !== m)
    .map((o) =>
      ban(
        [`@/modules/${o}/*`, `!@/modules/${o}/service`, `@/modules/${o}/service/database`],
        `MODULES.md, modules keep to themselves: ${m} may call ${o}'s service functions and nothing else of it.`,
      ),
    );
  const imports = (patterns) => ({
    "no-restricted-imports": [LEVEL, { patterns: [...patterns, ...cross] }],
  });
  return [
    // Every file of the module; the three blocks after it replace this for their own folders.
    ...(cross.length ? [{ files: [`${own}/**`], rules: imports([]) }] : []),
    {
      files: [`${own}/components/**`],
      rules: imports([
        ban(DB(m), "MODULES.md, one write path: a component never imports the module's database connection."),
        ban(DRIVER, "MODULES.md, one write path: a component never talks to a database."),
        ban(
          [`@/modules/${m}/service/database`],
          "Components take types from service files, not the database interface.",
        ),
      ]),
    },
    {
      files: [`${own}/service/**`],
      rules: imports([
        ban(DB(m), "The service takes its database as an argument; it never imports db.ts."),
        ban(FRAMEWORK, "The service imports nothing from Next.js or React, so tests can run it directly."),
        ban(
          ["../components/*", "../actions", `@/modules/${m}/components/*`, `@/modules/${m}/actions`],
          "The service does not depend on the screens.",
        ),
      ]),
    },
    {
      files: [`${own}/forecast/**`, `${own}/**/pure/**`],
      rules: imports([
        ban(
          [...FRAMEWORK, ...DRIVER, ...DB(m), "../service/*", "@/*"],
          "MODULES.md, pure logic stays pure: no Next.js, React, database or app imports.",
        ),
      ]),
    },
    {
      files: [
        `${own}/actions.ts`,
        `${own}/api.ts`,
        `${own}/current-actor.ts`,
        `${own}/components/**`,
        `src/app/**/${m}/**`,
      ],
      rules: {
        "no-restricted-syntax": [
          LEVEL,
          {
            selector: "CallExpression[callee.type='MemberExpression'][callee.property.name=/^(query|transaction)$/]",
            message: "MODULES.md, one write path: only service/ runs SQL. Call a service function instead.",
          },
        ],
      },
    },
  ];
});

// The rest of the app reaches a module through its pages and API only.
const outside = {
  files: ["src/**"],
  ignores: [
    "src/modules/**",
    ...modules.map((m) => `src/app/**/${m}/**`),
    // The app shell is allowed to know which modules are switched on.
    "src/lib/permissions.ts",
    "src/lib/route-permissions.ts",
  ],
  rules: {
    "no-restricted-imports": [
      LEVEL,
      {
        patterns: modules.map((m) =>
          ban(
            [`@/modules/${m}/db`, `@/modules/${m}/current-actor`, `@/modules/${m}/actions`, `@/modules/${m}/service/*`],
            `Code outside the ${m} module and its pages does not reach into it. Use its pages or /api/${m}.`,
          ),
        ),
      },
    ],
  },
};

export default modules.length ? [...perModule, outside] : [];
