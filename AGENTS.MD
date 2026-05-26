<!-- intent-skills:start -->
## Skill Loading

Before substantial work:
- Skill check: run `bunx @tanstack/intent@latest list`, or use skills already listed in context.
- Skill guidance: if one local skill clearly matches the task, run `bunx @tanstack/intent@latest load <package>#<skill>` and follow the returned `SKILL.md`.
- Monorepos: when working across packages, run the skill check from the workspace root and prefer the local skill for the package being changed.
- Multiple matches: prefer the most specific local skill for the package or concern you are changing; load additional skills only when the task spans multiple packages or concerns.
<!-- intent-skills:end -->

For UI implementation make sure the fallowing:
  loaded skills:
    - frontend-design
    - web-design-guidelines
    - ce-frontend-design
  repositories of references:
    this repositories are used as reference for design and implementation of the UI, they are not meant to be used as dependencies or to be loaded as skills, but they can be used as inspiration/reference for design and implementation of the UI.:
    - chartdb: https://github.com/chartdb/chartdb (this is a great implementation for an extra section of the admin panel to allow the user build their collection in an easly way, the name isn't what it means really it isn't a chart database, it's more like a database builder or saying less db diagram builder)
    - strapi: https://github.com/strapi/strapi (the admin panel is a good reference for design and implementation of the UI rather copy the User Interface of the admin panel, but the code should be migrated to new implementation using the packages listed below + shadcn/ui components)
  packages:
    - @tanstack/(query|router|hot-keys|table|pacer|store(could be jotai as state 
  manager)|form)
    - nuqs
    - date-fns
  these packages are tools that must be core of the UI implementation, they should be used as the main building blocks for the UI, and they should be used to implement the features of the UI, these packages are SUPER USEFUL tools that can help to implement the UI in a more efficient and effective way, they should be used as much as possible to implement the features of the UI.

