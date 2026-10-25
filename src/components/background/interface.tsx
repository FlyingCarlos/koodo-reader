export interface BackgroundProps {
  comparisonViewport?: { pageOffset: string; pageWidth: string };
  readerMode: string;
  scale: string;
  margin: string;
  isNavLocked: boolean;
  isSettingLocked: boolean;
  isDockedRight: boolean;
  backgroundColor: string;
  readerBackgroundImage?: string;
}
export interface BackgroundState {
  isSingle: boolean;
  pageOffset: string;
  pageWidth: string;
  readerBackgroundUrl: string;
}
