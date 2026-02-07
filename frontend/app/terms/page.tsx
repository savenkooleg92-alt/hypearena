export default function TermsPage() {
  return (
    <div className="container mx-auto px-4 py-8 max-w-3xl">
      <h1 className="text-3xl font-bold text-gray-900 dark:text-white mb-2">Terms of Service</h1>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-8">(February 6, 2026)</p>

      <div className="prose prose-gray dark:prose-invert max-w-none space-y-4 text-gray-700 dark:text-dark-text-secondary">
        <h2 className="text-xl font-semibold text-gray-900 dark:text-white mt-6">1. General Provisions</h2>
        <p>
          These Terms of Service (&quot;Terms&quot;) govern the use of the Platform, including participation in events, placement of positions, calculation of winnings, and payout processing.
        </p>
        <p>By using the Platform, the User agrees to these Terms in full.</p>

        <h2 className="text-xl font-semibold text-gray-900 dark:text-white mt-6">2. Events and Winning Calculation</h2>
        <p>Each event on the Platform has predefined rules, conditions, and payout mechanics.</p>
        <p>The User&apos;s potential winnings are calculated based on:</p>
        <ul className="list-disc pl-6 space-y-1">
          <li>the final outcome of the event,</li>
          <li>the User&apos;s position in the event,</li>
          <li>the final winning percentage (payout percentage) assigned to that position at the time the event is settled.</li>
        </ul>
        <p>Winning percentages may vary between events and users and are not fixed or guaranteed in advance.</p>

        <h2 className="text-xl font-semibold text-gray-900 dark:text-white mt-6">3. Payout Guarantee</h2>
        <h3 className="text-lg font-medium text-gray-900 dark:text-white mt-4">3.1 Scope of the Guarantee</h3>
        <p>
          The Platform guarantees the payout of a User&apos;s winnings only within the limits of the final winning percentage of a specific completed event.
        </p>
        <p>
          If an event is completed successfully and settled as valid, the Platform guarantees that the User will receive the payout corresponding to their final calculated winning percentage for that event.
        </p>
        <h3 className="text-lg font-medium text-gray-900 dark:text-white mt-4">3.2 Conditions for Guaranteed Payout</h3>
        <p>The payout guarantee applies only if all of the following conditions are met:</p>
        <ul className="list-disc pl-6 space-y-1">
          <li>the event has been completed and finalized;</li>
          <li>the event result is confirmed using supported and trusted data sources (oracles);</li>
          <li>the User complied with all Platform rules and Terms;</li>
          <li>no abuse, fraud, manipulation, or prohibited activity is detected.</li>
        </ul>
        <h3 className="text-lg font-medium text-gray-900 dark:text-white mt-4">3.3 No Fixed Profit Guarantee</h3>
        <p>The Platform does not guarantee:</p>
        <ul className="list-disc pl-6 space-y-1">
          <li>fixed profits,</li>
          <li>guaranteed income,</li>
          <li>positive returns on participation,</li>
          <li>or winnings outside the final winning percentage of a specific event.</li>
        </ul>
        <p>All participation involves risk, and outcomes depend on the event result.</p>

        <h3 className="text-lg font-medium text-gray-900 dark:text-white mt-4">Politics markets</h3>
        <p>
          Politics markets close strictly at the specified UTC end time. Betting is not possible after that time. Winnings are paid only after the market is RESOLVED. Resolution may occur after betting has ended.
        </p>

        <h2 className="text-xl font-semibold text-gray-900 dark:text-white mt-6">4. Limitations and Disclaimers</h2>
        <p>The Platform is not responsible for losses or missed opportunities caused by:</p>
        <ul className="list-disc pl-6 space-y-1">
          <li>changes in odds or payout percentages during an event;</li>
          <li>event cancellation, correction, or invalidation by the data provider;</li>
          <li>blockchain network congestion or delays;</li>
          <li>technical failures outside reasonable control;</li>
          <li>force majeure events.</li>
        </ul>
        <p>Payouts are executed strictly according to finalized event data.</p>

        <h2 className="text-xl font-semibold text-gray-900 dark:text-white mt-6">5. Blockchain Transactions</h2>
        <p>All deposits, withdrawals, and payouts are executed via blockchain networks.</p>
        <p>The Platform:</p>
        <ul className="list-disc pl-6 space-y-1">
          <li>does not store users&apos; private keys;</li>
          <li>cannot reverse or modify confirmed blockchain transactions;</li>
          <li>does not control blockchain confirmation times.</li>
        </ul>
        <p>Users are solely responsible for providing correct wallet addresses.</p>

        <h2 className="text-xl font-semibold text-gray-900 dark:text-white mt-6">6. Prohibited Activities</h2>
        <p>The following activities are strictly prohibited:</p>
        <ul className="list-disc pl-6 space-y-1">
          <li>exploitation of bugs or system vulnerabilities;</li>
          <li>manipulation of events or data sources;</li>
          <li>use of automated systems for abuse;</li>
          <li>submission of false or misleading transaction data.</li>
        </ul>
        <p>Violation may result in suspension or termination of access.</p>

        <h2 className="text-xl font-semibold text-gray-900 dark:text-white mt-6">7. Amendments</h2>
        <p>
          The Platform reserves the right to update these Terms at any time. Continued use of the Platform constitutes acceptance of updated Terms.
        </p>
      </div>
    </div>
  );
}
