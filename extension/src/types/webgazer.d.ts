declare module 'webgazer' {
  export type WebGazerPrediction = { x: number; y: number } | null;

  export interface WebGazerInstance {
    begin(onFail?: () => void): Promise<WebGazerInstance>;
    end(): WebGazerInstance;
    stopVideo?(): WebGazerInstance;
    isReady(): boolean;
    pause(): WebGazerInstance;
    resume(): Promise<WebGazerInstance>;
    clearData(): Promise<void>;
    clearGazeListener(): WebGazerInstance;
    setGazeListener(listener: (data: WebGazerPrediction, elapsedTime: number) => void): WebGazerInstance;
    showVideoPreview(value: boolean): WebGazerInstance;
    showVideo?(value: boolean): WebGazerInstance;
    showFaceOverlay(value: boolean): WebGazerInstance;
    showFaceFeedbackBox(value: boolean): WebGazerInstance;
    showPredictionPoints(value: boolean): WebGazerInstance;
    saveDataAcrossSessions(value: boolean): WebGazerInstance;
    applyKalmanFilter(value: boolean): WebGazerInstance;
    setCameraConstraints?(constraints: MediaTrackConstraints): Promise<void>;
    getCurrentPrediction?(): WebGazerPrediction;
  }

  const webgazer: WebGazerInstance;
  export default webgazer;
}
