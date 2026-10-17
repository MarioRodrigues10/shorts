import { useEffect, useState } from "react";
import Home from "./components/Home.jsx";
import Editor from "./components/Editor.jsx";

function useHash() {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const h = () => setHash(location.hash);
    window.addEventListener("hashchange", h);
    return () => window.removeEventListener("hashchange", h);
  }, []);
  return hash;
}

export default function App() {
  const hash = useHash();
  const m = hash.match(/^#\/p\/([0-9a-f]{12})/);
  return m ? <Editor key={m[1]} id={m[1]} /> : <Home />;
}
