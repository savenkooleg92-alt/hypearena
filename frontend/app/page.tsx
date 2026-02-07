import MarketsList from '@/components/MarketsList'

export default function Home() {
  return (
    <div className="container mx-auto px-4 py-8">
      <div className="mb-8">
        <h1 className="text-4xl font-bold text-gray-900 dark:text-dark-text-primary mb-2">
          HYPE ARENA
        </h1>
        <p className="text-lg text-gray-600 dark:text-dark-text-secondary">
          Predict the future. Win rewards.
        </p>
      </div>
      <MarketsList />
    </div>
  )
}
