import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'AuxCord — Spotify spike',
  description: 'Technical spike: can Spotify act as AuxCord’s playback engine?',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
