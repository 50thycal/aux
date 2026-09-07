import Console from '@/components/Console'

export const dynamic = 'force-dynamic'

export default function Page() {
  return (
    <main className="wrap">
      <h1 style={{ fontSize: 16, margin: '4px 0 12px' }}>
        AUXCORD <span className="dim">/ spotify control-plane spike</span>
      </h1>
      <Console />
    </main>
  )
}
