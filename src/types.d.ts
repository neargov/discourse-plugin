// Type-only module augmentation to provide IDE autocomplete for the remote runtime
import type DiscoursePlugin from "./index";

declare module "every-plugin" {
  interface RegisteredPlugins {
    "discourse-plugin": typeof DiscoursePlugin;
  }
}
