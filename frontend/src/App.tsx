import { BrowserRouter, Routes, Route } from "react-router-dom";
import { AuthProvider } from "./context/AuthContext";
import { ProtectedRoute } from "./components/ProtectedRoute";
import { ToastProvider } from "./components/Toast";
import { Login } from "./pages/Login";
import { Register } from "./pages/Register";
import { Home } from "./pages/Home";

export function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        {/* 16-й проход (обзор по скриншотам, п.4): системная замена alert()
            на стилизованные уведомления — один провайдер на всё приложение,
            чтобы useToast() был доступен из любой вкладки без прокидывания
            пропсов. */}
        <ToastProvider>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/register" element={<Register />} />
          <Route
            path="/"
            element={
              <ProtectedRoute>
                <Home />
              </ProtectedRoute>
            }
          />
        </Routes>
        </ToastProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}
