// Custom type declarations for the project
declare module "html5-qrcode" {
  export class Html5Qrcode {
    constructor(elementId: string, config?: { verbose?: boolean });
    start(
      cameraIdOrConfig: string | { facingMode: string },
      configuration: {
        fps?: number;
        qrbox?: number | { width: number; height: number };
        aspectRatio?: number;
        disableFlip?: boolean;
        formatsToSupport?: number[];
      },
      qrCodeSuccessCallback: (decodedText: string, decodedResult: unknown) => void,
      qrCodeErrorCallback?: (errorMessage: string, error: unknown) => void
    ): Promise<void>;
    stop(): Promise<void>;
    clear(): void;
    getState(): number;
    isScanning: boolean;
  }
  export enum Html5QrcodeScanType {
    SCAN_TYPE_CAMERA = 0,
    SCAN_TYPE_FILE = 1,
  }
  export enum Html5QrcodeSupportedFormats {
    QR_CODE = 0,
    AZTEC = 1,
    CODABAR = 2,
    CODE_39 = 3,
    CODE_93 = 4,
    CODE_128 = 5,
    DATA_MATRIX = 6,
    MAXICODE = 7,
    ITF = 8,
    EAN_13 = 9,
    EAN_8 = 10,
    PDF_417 = 11,
    RSS_14 = 12,
    RSS_EXPANDED = 13,
    UPC_A = 14,
    UPC_E = 15,
    UPC_EAN_EXTENSION = 16,
  }
}
