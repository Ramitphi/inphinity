import { Header, Footer } from './components/Header'
import { usePath } from './lib/router'
import { Markets } from './pages/Markets'
import { Indices, IndexDetail } from './pages/Indices'
import { Create } from './pages/Create'
import { Portfolio } from './pages/Portfolio'
import { Bridge } from './pages/Bridge'
import { EnsName } from './pages/EnsName'
import { Link } from './lib/router'

function Route({ path }: { path: string }) {
  if (path === '/' || path === '') return <Markets />
  if (path === '/indices') return <Indices />
  const m = /^\/index\/([^/]+)\/?$/.exec(path)
  if (m) return <IndexDetail key={m[1]} address={m[1]} />
  if (path === '/create') return <Create />
  if (path === '/portfolio') return <Portfolio />
  if (path === '/bridge') return <Bridge />
  // ENS fund profiles: /bchip.inphinity.eth (also /ens/bchip.inphinity.eth or /ens/bchip)
  const e = /^\/(?:ens\/)?([a-z0-9-]+)(\.inphinity\.eth)?\/?$/i.exec(path)
  if (e && (e[2] || path.toLowerCase().startsWith('/ens/'))) return <EnsName key={e[1]} name={`${e[1].toLowerCase()}.inphinity.eth`} />
  return <div className="empty">Page not found. <Link to="/">Back to the board</Link></div>
}

export default function App() {
  const path = usePath()
  return (
    <div className="sheet">
      <Header />
      <main className="body"><Route path={path} /></main>
      <Footer />
    </div>
  )
}
