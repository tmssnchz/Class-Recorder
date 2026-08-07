import ReactDOM from "react-dom/client";
import App from "./App";

// Sin StrictMode a propósito: el doble montaje de efectos en desarrollo rompe
// el ciclo de vida del MediaRecorder (iniciaría y detendría la grabación).
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <App />,
);
