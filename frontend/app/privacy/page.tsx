export default function PrivacyPage() {
  return (
    <div className="container mx-auto px-4 py-8 max-w-3xl">
      <h1 className="text-3xl font-bold text-gray-900 dark:text-white mb-6">Privacy Policy</h1>

      <div className="prose prose-gray dark:prose-invert max-w-none space-y-4 text-gray-700 dark:text-dark-text-secondary">
        <h2 className="text-xl font-semibold text-gray-900 dark:text-white mt-6">1. Data Collection</h2>
        <p>The Platform may collect:</p>
        <ul className="list-disc pl-6 space-y-1">
          <li>blockchain wallet addresses;</li>
          <li>transaction hashes;</li>
          <li>event participation data;</li>
          <li>technical and usage data required for platform operation.</li>
        </ul>
        <p>The Platform does not collect private keys or sensitive authentication credentials.</p>

        <h2 className="text-xl font-semibold text-gray-900 dark:text-white mt-6">2. Use of Data</h2>
        <p>Collected data is used exclusively to:</p>
        <ul className="list-disc pl-6 space-y-1">
          <li>process events and payouts;</li>
          <li>ensure fairness and transparency;</li>
          <li>detect fraud and abuse;</li>
          <li>comply with legal and operational requirements.</li>
        </ul>

        <h2 className="text-xl font-semibold text-gray-900 dark:text-white mt-6">3. Blockchain Transparency</h2>
        <p>Due to the nature of blockchain technology:</p>
        <ul className="list-disc pl-6 space-y-1">
          <li>transactions are publicly verifiable on their respective blockchains;</li>
          <li>transaction data may be visible to third parties.</li>
        </ul>
        <p>The Platform does not control public blockchain data visibility.</p>

        <h2 className="text-xl font-semibold text-gray-900 dark:text-white mt-6">4. Data Security</h2>
        <p>
          Reasonable technical and organizational measures are applied to protect stored data. However, absolute security cannot be guaranteed.
        </p>

        <h2 className="text-xl font-semibold text-gray-900 dark:text-white mt-6">5. Third-Party Services</h2>
        <p>
          The Platform may rely on third-party services, including blockchain nodes and data providers (oracles). The Platform is not responsible for failures or inaccuracies originating from such services.
        </p>

        <h2 className="text-xl font-semibold text-gray-900 dark:text-white mt-6">6. User Responsibility</h2>
        <p>Users are responsible for:</p>
        <ul className="list-disc pl-6 space-y-1">
          <li>safeguarding access to their wallets;</li>
          <li>ensuring compliance with applicable laws in their jurisdiction;</li>
          <li>understanding the risks associated with blockchain-based platforms.</li>
        </ul>

        <h2 className="text-xl font-semibold text-gray-900 dark:text-white mt-6">7. Contact</h2>
        <p>
          For questions regarding these Terms or the Privacy Policy, Users may contact the Platform through official support channels.
        </p>
      </div>
    </div>
  );
}
