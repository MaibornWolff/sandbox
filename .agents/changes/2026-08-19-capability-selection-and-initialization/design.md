---
datetime: 2026-08-19T19:56:22+00:00
author: Tobias Wagner
tags: [design, initialization, tools, tui]
---

# Capability Selection and Initialization

## Purpose

Redesign `sandbox init` around user capabilities instead of installation mechanisms.

The current model presents agents, runtimes, and tools as separate lists. Users must understand hidden dependencies. A selection can also omit a required component. For example, browser automation can depend on Node.js and Chromium.

The new design separates three concerns:

```text
User selects capabilities
        |
        v
System resolves components and dependencies
        |
        v
Image generator installs components in safe phases
```

This document defines the initialization flow, terminal user interface (TUI), modular preset structure, image setup declarations, and catalog migration policy.

## Initialization Flows

### User setup

```text
sandbox init
  |
  +-- Select AI agents
  |
  +-- Configure capabilities
  |     |-- Languages
  |     |-- Tools
  |     `-- AI agents
  |
  +-- Review direct and automatic selections
  |
  +-- Configure agent settings
  |
  `-- Review generated files
```

A new user setup preselects broad JavaScript and Python environments. Host tool detection can add more selections. Existing generated selections take precedence when Sandbox can recover them.

The first agent screen keeps AI agents prominent. The complete capability tree repeats them so that the user can revise the selection.

### Project setup

```text
sandbox init --project
  |
  +-- Customize the project image?
  |     |
  |     +-- No  --> Create project configuration only
  |     |
  |     `-- Yes --> Detect project capabilities
  |                  |
  |                  +-- Configure capabilities
  |                  `-- Review generated files
```

Project detection uses project configuration and lock files. It does not use host commands. It does not preselect AI agents.

A project Dockerfile is optional. Sandbox must not create one when the project only needs `.sandbox/config.toml`. Sandbox must preserve an existing project Dockerfile when the user declines image customization.

## Capability Tree

The capability editor uses one searchable tree. Size the visible tree from the terminal height and keep space for the description and help panels.

```text
  [ Continue ]

┃ − Languages                       5 selected
    − ◐ JavaScript                    3 of 4 selected
        ● Node.js + npm               default
        ● pnpm                        default
        ● Bun                         default
        ○ Yarn                        available
    + ● Python                        2 of 2 selected

  − Tools                           2 selected
    − ◐ Browser and documents         2 of 3 selected
        ● Agent Browser
        ◆ Chromium                    required by Agent Browser

  + AI agents                       1 selected

  [ Continue ]
```

The prototype catalog is illustrative. It does not define the final supported capabilities or bundles. Indent each tool beyond its parent category selection symbol so leaves do not appear at the category level. Show `[ Continue ]` at both the top and bottom of the tree.

### Visual states

| Symbol | Meaning |
| --- | --- |
| `○` | Available and not selected |
| `●` | Selected directly |
| `◐` | Some descendants are selected |
| `◆` | Included automatically |
| `+` | Collapsed |
| `−` | Expanded |
| `┃` | Focused row |

Use restrained color:

- Use cyan for focus, automatic-state symbols, and links.
- Use green for direct-selection symbols.
- Use yellow for partial-selection symbols.
- Keep labels, counts, and dependency explanations neutral or dim.

### Description panel

Show the focused item in a fixed panel below the tree.

```text
Node.js + npm
JavaScript runtime with the npm package manager.
Docs: https://nodejs.org
```

Keep the visible URL. Add an Operating System Command 8 (OSC 8) hyperlink when the terminal supports it.

### Search

Search the complete catalog, including collapsed descendants.

Search these values:

- name
- description
- URL
- aliases
- parent group
- ecosystem

Show matching ancestors to preserve context. Restore the earlier expansion state when search closes.

## Input Model

Support keyboard and mouse input across the complete wizard.

### Keyboard

| Input | Action |
| --- | --- |
| `Up`, `Down`, `j`, `k` | Move focus |
| `Left`, `Right`, `h`, `l` | Collapse or expand |
| `Space` | Change selection |
| `Enter` | Activate the focused row |
| `Tab`, `Shift+Tab` | Move between sections |
| `Home`, `g` | Move to the first item |
| `End`, `G` | Move to the bottom Continue action |
| `/` | Search |

`Enter` expands or collapses a parent. It toggles a leaf. It opens review on `[ Continue ]`.

### Mouse

Apply mouse support to all wizard prompts, not only the capability tree.

- Click a section or group label to expand or collapse it.
- Click a selection symbol to change the selection.
- Click a leaf to change the selection.
- Click an action to activate it.
- Calculate click targets from physical terminal rows so wrapped labels remain attached to their choice.
- When the user moves the mouse wheel, release mouse tracking so the terminal can scroll its native history. Do not use the wheel to change the focused option.
- Keep all actions available from the keyboard.

Mouse tracking can affect terminal hyperlink behavior. Keep URLs visible and preserve terminal-native modifier-click behavior where possible.

## Defaults and Detection

| Scope | Source | Policy |
| --- | --- | --- |
| Existing user setup | Generated selection metadata | Restore the existing selection |
| New user setup | Built-in defaults | Select broad JavaScript and Python environments |
| New user setup | User-init detector declarations | Add matching environments, tools, and agents |
| Project setup | Project-init detector declarations | Select only detected project components |
| Project setup | AI agents | Do not select automatically |

A broad user environment provides a useful toolbox. A project selection stays minimal and follows project evidence.

For example:

```text
User JavaScript environment
  Node.js + npm
  pnpm
  Bun
  Yarn available but not selected

Project JavaScript detection
  package.json     --> Node.js
  pnpm-lock.yaml   --> pnpm
  bun.lock         --> Bun
```

## Preset and Registry Model

Keep preset data separate from registry logic.

```text
src/modules/workspace-setup/tools/
|-- category-definition.ts
|-- detection.ts
|-- image-setup.ts
|-- preset-definition.ts
|-- tool-definition.ts
|-- tool-resolution.ts
`-- presets/
    |-- javascript.ts
    |-- python.ts
    |-- browser-documents.ts
    |-- ai-agents.ts
    `-- index.ts
```

Each preset file owns one category and its tools. Every tool declares a typed reference to that category.

```ts
const javascript = defineCategory({
  id: "javascript",
  name: "JavaScript",
  section: "languages",
  description: "JavaScript runtimes and package managers",
})

const tools = [
  {
    id: "node",
    name: "Node.js + npm",
    category: javascript,
    defaultForUserInit: true,
    detect: {
      duringUserInit: [
        hasExecutable("node"),
        hasPath("~/.nvmrc"),
      ],
      duringProjectInit: [
        hasPath("./package.json"),
      ],
    },
    imageSetup: {
      asContainerUser: [
        installMiseTools(["node@lts"]),
      ],
    },
  },
] satisfies readonly ToolDefinition<typeof javascript>[]

export const javascriptPreset = {
  category: javascript,
  tools,
} satisfies PresetDefinition<typeof javascript>
```

Use a branded category reference instead of a central category union. This keeps category assignment type-safe without defining every category in one type.

`presets/index.ts` composes the catalog explicitly:

```ts
export const PRESET_REGISTRY = [
  javascriptPreset,
  pythonPreset,
  browserDocumentsPreset,
  aiAgentsPreset,
] as const
```

Derive category membership from each tool declaration. Do not repeat tool IDs in a preset membership list.

Use this display order:

1. Keep the section order fixed as Languages, Tools, and AI agents.
2. Use preset registry order within each section.
3. Use tool declaration order within each preset.

Do not add numeric order fields.

### Detection declarations

Each tool owns its detection declarations. Keep user and project initialization explicit.

```ts
detect: {
  duringUserInit: [
    hasExecutable("node"),
    hasPath("~/.nvmrc"),
  ],
  duringProjectInit: [
    hasPath("./package.json"),
  ],
}
```

Each detector list uses OR semantics. Support executable checks and exact path checks. Do not support glob or file-content detectors until a tool requires them.

Use these path rules:

- User initialization accepts `~/` paths and absolute paths.
- User initialization rejects relative paths.
- Project initialization accepts `./` paths relative to the resolved project root.
- Project initialization normalizes paths and rejects traversal outside the project root.
- Project initialization does not support absolute paths until a real requirement exists.
- Use platform path APIs for Windows compatibility.

Keep detection separate from build-context copying. A detected file does not automatically enter the image build context.

Store direct selections in the generated Dockerfile metadata. Treat each tool in a legacy `# Tools:` comment as a direct selection. Do not store automatic dependencies in the metadata.

## Dependency Behavior

Dependencies must remain visible.

```text
● Agent Browser
◆ Chromium          required by Agent Browser
◆ Node.js + npm     required by Agent Browser
```

A user can select an automatic dependency directly. The direct selection then remains after the dependent capability is cleared.

A user cannot remove a dependency while a selected capability still requires it. Clearing a direct selection changes it back to automatic.

Declare dependencies with direct tool object references:

```ts
const agentBrowser = defineTool({
  id: "agent-browser",
  requires: [node, chromium],
})
```

Registry composition must reject duplicate tool IDs, references to unregistered tools, and dependency cycles.

Keep every component at one canonical location in the tree. Do not duplicate Node.js below each dependent tool.

## Image Generation Boundary

Capability selection must not expose image setup details.

```text
Capability or preset
  -> selected components
  -> dependency closure
  -> actions that run as root
  -> ownership barrier
  -> actions that run as the container user
  -> generated image layer
```

Use `imageSetup` because actions can install and configure components.

```ts
imageSetup: {
  asRoot: [
    installAptPackages([
      "libnss3",
      "libx11-6",
    ]),
  ],
  asContainerUser: [
    installNpmPackages([
      "@example/report-tool@latest",
    ]),
  ],
}
```

Use plural action helpers consistently:

```ts
installAptPackages(["git", "curl"])
installNpmPackages(["typescript@5.9.2"])
installMiseTools(["node@lts", "python@3.13"])
installGoPackages(["github.com/example/tool@v1.2.3"])
installCargoPackages(["ripgrep@14.1.1"])
```

Pass package-manager-native version strings through to the applicable package manager. Do not parse them into separate package and version fields.

The generator combines all `asRoot` actions before the ownership barrier. It then combines all `asContainerUser` actions. It must not switch back to root during the container-user setup phase.

Bundle package actions by package manager in each phase. Preserve package declaration order inside each bundle. Preserve declaration order for the other actions.

When generated comments are enabled, keep explanatory comments for the language and tool section and for the optional `GITHUB_TOKEN` build argument. Comments must not split package-manager bundles.

A root action must declare each absolute container path that the container user owns. The generator applies ownership once at the barrier between root actions and container-user actions. Build ownership and runtime mount ownership remain separate concerns. After setup, restore the root runtime user because the managed entrypoint configures networking and mount ownership before it drops privileges.

See [Architecture](../../docs/ARCHITECTURE.md) and [Layered Images](../../docs/LAYERED-IMAGES.md).

## Key Decisions

### Use capability groups

- **Decision:** Group choices under Languages, Tools, and AI agents.
- **Reason:** These groups match user goals and do not expose package-manager implementation details.
- **Trade-offs:** Some components can belong to more than one conceptual area. Each component still needs one canonical display location.

### Use one expandable capability editor

- **Decision:** Edit all capabilities in one two-level tree with collapsible sections.
- **Reason:** The user can compare selections without moving through many detail screens.
- **Trade-offs:** The tree requires a custom prompt and careful terminal rendering.

### Keep agents prominent

- **Decision:** Show a separate agent screen first during user setup. Repeat agents at the end of the complete tree.
- **Reason:** Agent choice is the most important user-level decision.
- **Trade-offs:** The agent selection appears twice.

### Use broad user defaults and granular project detection

- **Decision:** Preselect broad JavaScript and Python environments for new users. Select project components only from project evidence.
- **Reason:** A user image is a reusable toolbox. A project image should stay small and specific.
- **Trade-offs:** User images contain tools that some projects do not use.

### Keep project Dockerfiles optional

- **Decision:** Ask whether the project needs image customization. Create only project configuration when it does not.
- **Reason:** Many projects only change Sandbox configuration.
- **Trade-offs:** Users must make one explicit choice before capability selection.

### Show dependencies as automatic selections

- **Decision:** Show automatic components in the tree with a separate state.
- **Reason:** Users can understand why a component is installed and can keep it directly.
- **Trade-offs:** Selection state must track direct and automatic reasons separately.

### Use a fixed description panel

- **Decision:** Show one focused description and visible URL below the tree.
- **Reason:** The tree stays compact while documentation remains discoverable.
- **Trade-offs:** Users must focus an item to read its description.

### Support keyboard and mouse input

- **Decision:** Add mouse behavior to shared wizard prompt primitives. Keep complete keyboard and Vim-style navigation.
- **Reason:** Both input styles must work across the full initialization flow.
- **Trade-offs:** Mouse reporting adds terminal compatibility and hyperlink concerns.

### Separate presentation from installation

- **Decision:** Keep capability grouping independent from dependency resolution and installation phases.
- **Reason:** User interface changes must not change installer privilege or ownership policy.
- **Trade-offs:** The registry needs explicit links between presets, components, dependencies, detection, and installation behavior.

### Keep presets modular

- **Decision:** Put all preset declarations in `tools/presets/`. Let one file own each category and its tools.
- **Reason:** Catalog data stays separate from selection, resolution, and generation logic.
- **Trade-offs:** A central composition file must still import each preset.

### Use typed category references

- **Decision:** Let every tool reference a branded category object. Do not define a closed category union.
- **Reason:** Categories remain type-safe and can be added in separate files.
- **Trade-offs:** Runtime validation must still detect duplicate IDs across modules.

### Derive preset membership

- **Decision:** Derive a preset's members from tool category references. Mark user defaults on each tool.
- **Reason:** Tool IDs do not appear in both tool declarations and preset membership lists.
- **Trade-offs:** The preset module must validate that every exported tool references its category.

### Keep detection with each tool

- **Decision:** Define `duringUserInit` and `duringProjectInit` detector lists on each tool. Use `hasExecutable()` and `hasPath()` helpers.
- **Reason:** Detection remains local, readable, and flexible for both initialization flows.
- **Trade-offs:** A detector that applies to both flows appears in both lists.

### Restrict detection paths

- **Decision:** Require home or absolute paths during user initialization. Allow only project-relative paths during project initialization for now.
- **Reason:** Relative user paths have no stable base. Project detection must not inspect arbitrary host paths.
- **Trade-offs:** A future tool with a valid absolute project detector will require a policy extension.

### Derive display order

- **Decision:** Fix section order. Use registry order for presets and declaration order for tools.
- **Reason:** File structure controls order without numeric metadata.
- **Trade-offs:** Moving an item requires moving its declaration or registry entry.

### Use direct dependency references

- **Decision:** Declare dependencies with direct tool object references.
- **Reason:** TypeScript validates each reference without repeating a string ID.
- **Trade-offs:** Preset modules must keep dependency imports one-way. Registry validation must still reject unregistered references and dependency cycles.

### Model image setup by execution identity

- **Decision:** Use `imageSetup.asRoot` and `imageSetup.asContainerUser` action lists.
- **Reason:** These names state when and as whom each action runs. They also keep the ownership barrier visible.
- **Trade-offs:** A tool with actions in both phases has a more verbose declaration.

### Use plural image setup actions

- **Decision:** Use imperative plural helpers such as `installNpmPackages()` and `installMiseTools()`. Pass package-manager-native version strings without parsing them.
- **Reason:** The calls read as actions and use one consistent form for one or many packages.
- **Trade-offs:** Registry validation cannot inspect package names and versions as separate fields.

### Preserve the catalog by capability

- **Decision:** Keep each current tool. Add a Python runtime. Group tools by ecosystem or purpose.
- **Reason:** The migration must not remove supported tools. Broad Python defaults require a Python runtime.
- **Trade-offs:** The catalog has more categories than the current runtime, agent, and tool lists.

### Keep agent catalogs separate

- **Decision:** Keep initialization capabilities separate from agent execution definitions. Link agent settings through the existing agent configuration identifier.
- **Reason:** Installation choices and runtime launch behavior have different owners.
- **Trade-offs:** Agent names and identifiers exist in two validated catalogs.
