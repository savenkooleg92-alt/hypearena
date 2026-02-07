export default function FAQPage() {
  return (
    <div className="container mx-auto px-4 py-8 max-w-3xl">
      <h1 className="text-3xl font-bold text-gray-900 dark:text-white mb-2">FAQ — Frequently Asked Questions</h1>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-8">(February 6, 2026)</p>

      <div className="space-y-6 text-gray-700 dark:text-dark-text-secondary">
        <div>
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-2">What is the Platform?</h2>
          <p>
            The Platform is an event-based participation system where users take part in battles and events with predefined rules and outcome-based payouts.
          </p>
          <p>
            All results, calculations, and payouts are determined by finalized event outcomes and transparent on-chain transactions.
          </p>
        </div>

        <div>
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-2">How are winnings calculated?</h2>
          <p>Winnings are calculated based on:</p>
          <ul className="list-disc pl-6 space-y-1 mt-2">
            <li>the final outcome of the event,</li>
            <li>your participation in that event,</li>
            <li>the final winning percentage assigned to your position when the event is settled.</li>
          </ul>
          <p>Winning percentages are event-specific and may vary.</p>
        </div>

        <div>
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-2">Are winnings guaranteed?</h2>
          <p>
            The Platform guarantees payouts only within the final winning percentage of a completed and valid event.
          </p>
          <p>
            There are no fixed profits or guaranteed returns. Outcomes depend entirely on the event result.
          </p>
        </div>

        <div>
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-2">When do payouts happen?</h2>
          <p>Payouts are processed after:</p>
          <ul className="list-disc pl-6 space-y-1 mt-2">
            <li>the event is completed,</li>
            <li>results are confirmed via supported data sources,</li>
            <li>the event is finalized.</li>
          </ul>
          <p>Blockchain confirmation times may vary depending on network conditions.</p>
          <p className="mt-2">
            <strong>Politics markets:</strong> Betting closes strictly at the stated UTC end time. Winnings are paid only after the market is RESOLVED; resolution may occur after betting has ended.
          </p>
        </div>

        <div>
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-2">Can an event or battle be canceled?</h2>
          <p>Yes. An event may be canceled or invalidated if:</p>
          <ul className="list-disc pl-6 space-y-1 mt-2">
            <li>required data is unavailable or incorrect,</li>
            <li>technical issues occur,</li>
            <li>abuse, manipulation, or rule violations are detected.</li>
          </ul>
          <p>In such cases, funds are handled according to Platform rules and applicable safeguards.</p>
        </div>

        <div>
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-2">What is a Battle Proposal?</h2>
          <p>
            A Battle Proposal allows users to suggest and submit their own custom battles or events to the Platform.
          </p>
          <p>All proposals are reviewed before being approved.</p>
        </div>

        <div>
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-2">What happens if my Battle Proposal is approved?</h2>
          <p>If your Battle Proposal is approved and published on the Platform:</p>
          <ul className="list-disc pl-6 space-y-1 mt-2">
            <li>you are recognized as the battle creator;</li>
            <li>you receive a 0.5% creator fee from the total pool of that battle;</li>
            <li>the creator fee is calculated automatically from the full event pool;</li>
            <li>the creator fee is distributed after the event is completed and finalized.</li>
          </ul>
        </div>

        <div>
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-2">Is the creator fee guaranteed?</h2>
          <p>The creator fee is paid only if:</p>
          <ul className="list-disc pl-6 space-y-1 mt-2">
            <li>the battle is approved and launched;</li>
            <li>the battle is completed successfully;</li>
            <li>the event is not canceled or invalidated.</li>
          </ul>
          <p>If a battle is canceled, creator fees are not distributed.</p>
        </div>

        <div>
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-2">Can anyone submit a Battle Proposal?</h2>
          <p>Yes, but approval is not automatic.</p>
          <p>The Platform reserves the right to:</p>
          <ul className="list-disc pl-6 space-y-1 mt-2">
            <li>approve or reject proposals,</li>
            <li>modify or decline proposals that do not meet quality, fairness, or risk standards.</li>
          </ul>
        </div>

        <div>
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-2">Can I submit multiple Battle Proposals?</h2>
          <p>
            Yes. Users may submit multiple proposals, subject to review and approval.
          </p>
          <p>Abusive or spam submissions may result in restrictions.</p>
        </div>

        <div>
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-2">Do I need to pay to submit a Battle Proposal?</h2>
          <p>
            At this time, submitting a proposal does not guarantee approval and may require compliance with additional rules or limits set by the Platform.
          </p>
        </div>

        <div>
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-2">How are deposits and withdrawals handled?</h2>
          <p>All deposits and withdrawals are executed via blockchain networks.</p>
          <p>The Platform:</p>
          <ul className="list-disc pl-6 space-y-1 mt-2">
            <li>does not store private keys;</li>
            <li>cannot reverse confirmed transactions;</li>
            <li>does not control blockchain confirmation speed.</li>
          </ul>
          <p>Users must ensure wallet addresses are correct.</p>
        </div>

        <div>
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-2">What risks should I be aware of?</h2>
          <p>Participation involves risks, including:</p>
          <ul className="list-disc pl-6 space-y-1 mt-2">
            <li>event outcome uncertainty,</li>
            <li>blockchain network delays,</li>
            <li>technical issues beyond the Platform&apos;s control.</li>
          </ul>
          <p>Users should only participate if they understand these risks.</p>
        </div>

        <div>
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-2">Can I lose my funds?</h2>
          <p>
            Yes. If the outcome of an event does not favor your position, you may lose part or all of your participation amount.
          </p>
          <p>There are no guaranteed profits.</p>
        </div>

        <div>
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-2">How does the Platform prevent abuse?</h2>
          <p>The Platform uses:</p>
          <ul className="list-disc pl-6 space-y-1 mt-2">
            <li>automated checks,</li>
            <li>data validation,</li>
            <li>monitoring of suspicious behavior.</li>
          </ul>
          <p>Abuse, fraud, or manipulation may result in suspension or permanent access restriction.</p>
        </div>

        <div>
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-2">Where can I get support?</h2>
          <p>
            For support or questions, please use the Platform&apos;s official support channels.
          </p>
        </div>
      </div>
    </div>
  );
}
