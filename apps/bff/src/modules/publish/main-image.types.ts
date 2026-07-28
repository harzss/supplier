export const MAIN_IMAGE_BACKGROUND_STYLES = [
  'white_studio',
  'warm_lifestyle',
  'cool_minimal',
] as const;

export type MainImageBackgroundStyle = (typeof MAIN_IMAGE_BACKGROUND_STYLES)[number];

export interface MainImageOperations {
  removeWatermark: boolean;
  relight: boolean;
  backgroundStyle?: MainImageBackgroundStyle;
}
