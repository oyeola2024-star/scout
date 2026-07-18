const pages = [
  {
    title: "Home",
    items: [
      ["Today numbers", "Shows what happened today, like leads found, emails sent, and replies."],
      ["Download today report", "Downloads a small report you can keep or send to someone."],
      ["Notification bell", "Opens small alerts from Scout, like replies or due sends."],
      ["Live Work", "Small box at the bottom. It shows what Scout is doing right now."],
      ["Setup checklist", "Twelve important steps. Scout ticks a step when it sees that you have done it, including replying to a prospect from Scout."],
      ["Next action cards", "Big shortcuts for Find emails, Send emails, Send follow-ups, and Challenges."],
    ],
  },
  {
    title: "Find Leads",
    items: [
      ["Upload CSV", "Add your lead list from a spreadsheet."],
      ["Auto Scout", "Scout checks leads that are missing emails. Results appear on the same page below the Start button."],
      ["Verify emails", "Check leads before sending. You can remove bad emails or ask Scout to look again."],
      ["Leads list", "Shows the people and businesses you have uploaded or found."],
      ["Country filter", "Shows countries found in your uploaded leads. It does not show street addresses."],
      ["Bad inboxes", "Shows emails that bounced, were blocked, or should not be contacted again."],
    ],
  },
  {
    title: "Send Emails",
    items: [
      ["Ready to send", "Number of leads Scout can contact now."],
      ["Connected senders", "How many Gmail accounts are ready to send."],
      ["Due follow-ups", "People you emailed more than 72 hours ago who did not send a reply."],
      ["Audience", "Choose the group of leads you want to email."],
      ["Location from uploaded list", "Choose a country from the leads you uploaded. This helps you send by country."],
      ["Template category", "Choose the type of email you want to send."],
      ["How many", "How many emails Scout should send in this run."],
      ["Delay between emails", "Wait time between emails. A delay can make sending safer."],
      ["Template", "Choose one template or rotate different templates."],
      ["Sender", "Choose one Gmail account or rotate many Gmail accounts."],
      ["Max from this sender", "The most this Gmail account should send in this run."],
      ["Send Now", "Starts sending immediately. Stay on Scout while it sends."],
      ["Refresh", "Reloads the numbers and lists."],
      ["More options", "Shows extra tools like test-only mode, fixing lead status, checking bad inboxes, and downloading results."],
      ["Ready Leads", "Hidden by default. Click Show when you want to choose exact leads."],
      ["Preview", "Hidden by default. Click Show when you want to see the email before sending."],
      ["Follow-up template to use", "Choose the follow-up message before sending due follow-ups. First-message templates are not used here."],
      ["Send Due Follow-ups Now", "Sends follow-up emails now to people who are due."],
      ["Schedule Email", "Save a first-email send for later. Open Scout at that time or use the phone reminder."],
      ["Run Due Sends Now", "Starts saved sends whose time has arrived."],
      ["Add phone reminder", "Adds a phone/calendar reminder so you remember to open Scout."],
    ],
  },
  {
    title: "Replies",
    items: [
      ["Replies", "Messages Scout detected from prospects. Bounces and no-inbox notices do not count."],
      ["Auto replies", "Automatic messages like out-of-office, ticket created, or mailbox not monitored."],
      ["No inbox / blocked", "Emails that failed or should not be contacted again."],
      ["Conversation", "Open a lead to see what was sent and what they replied."],
    ],
  },
  {
    title: "Templates",
    items: [
      ["Initial template", "Used for first emails only."],
      ["Follow-up template", "Used for people who already got your first email but did not send a reply."],
      ["Reply template", "Used only when replying to a reply."],
      ["Subject", "The email title."],
      ["Body", "The email message."],
      ["Fields like {name}", "Scout replaces these with the lead name, company, website, and other details."],
    ],
  },

  {
    title: "Challenges",
    items: [
      ["Challenge card", "A goal that helps you grow. Some are quick wins, but most are big goals like 10,000, 100,000, 1,000,000, or 10,000,000 delivered messages."],
      ["Progress bar", "Shows how close you are to finishing that challenge."],
      ["Click a challenge", "A popup opens and tells you the exact steps to complete it."],
      ["Completed challenge", "Scout marks it when your numbers reach the target. The hard challenges are supposed to take time."],
    ],
  },
  {
    title: "Settings",
    items: [
      ["Connect Gmail", "Adds a Gmail account that Scout can use to send emails."],
      ["Daily safe limit", "The daily maximum you allow one Gmail account to send."],
      ["Default max/run", "The normal amount one Gmail account should send in one run."],
      ["Pause", "Stops one Gmail account from sending."],
      ["Upload logo", "Uploads your logo so Scout can use it in your email signature."],
      ["Save signature & logo", "Saves your signature inside Scout."],
      ["Save + sync to Gmail", "Saves the signature inside Gmail too."],
      ["App Health Check", "Checks if the important parts are ready before you send."],
    ],
  },
  {
    title: "APK / Phone App",
    items: [
      ["Open Scout from the app icon", "The APK opens your Scout web app in a phone app wrapper."],
      ["Allow notifications", "Lets the phone show reminders at the top of the screen."],
      ["Phone reminder", "This reminds you when a saved send is due. It does not secretly send while Scout is closed."],
    ],
  },
];

export default function HelpPage() {
  return (
    <div className="stack">
      <div className="page-title">
        <h2>How to Use Scout</h2>
        <p>Simple guide. No developer words. Read this when you forget what a button does.</p>
      </div>
      <div className="card" style={{ padding: 18 }}>
        <h3>The simple rule</h3>
        <p className="muted">Scout finds leads, sends emails, watches replies, and helps you follow up. If you want Scout to send, keep Scout open.</p>
      </div>
      {pages.map((page) => (
        <div className="card" style={{ padding: 18 }} key={page.title}>
          <h3>{page.title}</h3>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>What you see</th>
                  <th>What it means</th>
                </tr>
              </thead>
              <tbody>
                {page.items.map(([name, meaning]) => (
                  <tr key={name}>
                    <td><strong>{name}</strong></td>
                    <td>{meaning}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
      <div className="card" style={{ padding: 18 }}>
        <h3>Best daily flow</h3>
        <ol className="muted">
          <li>Upload or find leads.</li>
          <li>Run Auto Scout for leads without emails.</li>
          <li>Go to Send Emails.</li>
          <li>Pick audience, country, template, sender, and count.</li>
          <li>Click Send Now.</li>
          <li>Check Replies later.</li>
          <li>When a prospect replies, open the reply and answer from Scout.</li>
          <li>After 72 hours, go to Due Follow-ups, choose the follow-up template, and click Send Due Follow-ups Now.</li>
        </ol>
      </div>
    </div>
  );
}
