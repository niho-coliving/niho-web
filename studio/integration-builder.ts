import { defineBuilder, layoutInsertionPresets, type BuilderDefinition } from "../src/builder.js";

/** 全 integration が標準カタログに加えて明示的に利用する共通レイアウト定義。 */
export const studioBuilderDefinition: BuilderDefinition = defineBuilder({ insertions: layoutInsertionPresets });
