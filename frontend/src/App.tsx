import { Routes, Route } from 'react-router-dom';
import Navbar from './components/Navbar';
import DotGrid from './components/DotGrid';
import Dashboard from './pages/Dashboard';
import Stake from './pages/Stake';
import Withdraw from './pages/Withdraw';
import Lending from './pages/Lending';
import Liquidity from './pages/Liquidity';
import Governance from './pages/Governance';
import Leverage from './pages/Leverage';
import Restaking from './pages/Restaking';
import Bridge from './pages/Bridge';
import Analytics from './pages/Analytics';

function App() {
  return (
    <div className="min-h-screen text-white" style={{ position: 'relative', background: '#000' }}>

      {/* ── Dot grid — fixed full-screen background ──────────────────────── */}
      <div
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 0,
          pointerEvents: 'none',
        }}
      >
        <DotGrid
          dotSize={4}
          gap={18}
          baseColor="#1f1f0e"
          activeColor="#F5CF00"
          proximity={140}
          shockRadius={220}
          shockStrength={5}
          resistance={750}
          returnDuration={1.5}
        />
      </div>

      {/* ── App shell — above the dot grid ───────────────────────────────── */}
      <div style={{ position: 'relative', zIndex: 1 }}>
        <Navbar />
        <main className="pt-[60px]">
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/stake" element={<Stake />} />
            <Route path="/withdraw" element={<Withdraw />} />
            <Route path="/lending" element={<Lending />} />
            <Route path="/liquidity" element={<Liquidity />} />
            <Route path="/governance" element={<Governance />} />
            <Route path="/leverage" element={<Leverage />} />
            <Route path="/restaking" element={<Restaking />} />
            <Route path="/bridge" element={<Bridge />} />
            <Route path="/analytics" element={<Analytics />} />
          </Routes>
        </main>
      </div>
    </div>
  );
}

export default App;
