declare module 'qrcode-generator' {
  interface QrCode {
    addData(data: string, mode?: string): void;
    make(): void;
    getModuleCount(): number;
    isDark(row: number, col: number): boolean;
    createSvgTag(opts?: { cellSize?: number; margin?: number; scalable?: boolean }): string;
  }
  function qrcode(typeNumber: number, errorCorrectionLevel: 'L' | 'M' | 'Q' | 'H'): QrCode;
  export default qrcode;
}
