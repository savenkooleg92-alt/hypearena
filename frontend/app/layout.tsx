import type { Metadata, Viewport } from 'next'
import { Inter } from 'next/font/google'
import './globals.css'
import Navbar from '@/components/Navbar'
import AuthHydrate from '@/components/AuthHydrate'
import { ThemeProvider } from '@/components/ThemeProvider'
import LoadingScreen from '@/components/LoadingScreen'
import NavigationLoading from '@/components/NavigationLoading'
import ContentTransition from '@/components/ContentTransition'
import Footer from '@/components/Footer'

const inter = Inter({ subsets: ['latin'], display: 'swap' })

export const metadata: Metadata = {
  title: 'HYPE ARENA - Prediction Market',
  description: 'Create and participate in prediction markets',
  icons: {
    icon: [
      { url: '/hype_logo_flat.svg', sizes: 'any', type: 'image/svg+xml' },
      { url: '/hype_logo_flat.svg', sizes: '32x32', type: 'image/svg+xml' },
      { url: '/hype_logo_flat.svg', sizes: '48x48', type: 'image/svg+xml' },
    ],
    apple: [{ url: '/hype_logo_flat.svg', sizes: '180x180', type: 'image/svg+xml' }],
  },
  openGraph: {
    title: 'HYPE ARENA - Prediction Market',
    description: 'Create and participate in prediction markets',
  },
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f8fafc' },
    { media: '(prefers-color-scheme: dark)', color: '#0f172a' },
  ],
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={inter.className}>
        <ThemeProvider>
          <LoadingScreen />
          <AuthHydrate />
          <NavigationLoading />
          <Navbar />
          <main className="min-h-screen bg-[rgb(var(--bg-base))] dark:bg-dark-base flex flex-col">
            <ContentTransition>{children}</ContentTransition>
            <Footer />
          </main>
        </ThemeProvider>
        <script
          type="text/javascript"
          dangerouslySetInnerHTML={{
            __html: `
var Tawk_API=Tawk_API||{}, Tawk_LoadStart=new Date();
(function(){
var s1=document.createElement("script"),s0=document.getElementsByTagName("script")[0];
s1.async=true;
s1.src='https://embed.tawk.to/69861a7efcf37c1c39798919/1jgpteve2';
s1.charset='UTF-8';
s1.setAttribute('crossorigin','*');
s0.parentNode.insertBefore(s1,s0);
})();
`,
          }}
        />
      </body>
    </html>
  )
}
