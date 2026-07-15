import TurtleLoader from '../../components/TurtleLoader';
import NewSessionWorkspace from './NewSessionWorkspace';
import SessionChatWorkspace from './SessionChatWorkspace';

export default function SessionWorkspace({ loading, activeView, chatProps, newSessionProps }) {
  if (loading) {
    return (
      <div className="session-loading-stage">
        <TurtleLoader label="玄武正在召回最近会话…" />
      </div>
    );
  }

  return (
    <div className="sessions-client-container client-animate-fade-in">
      <main className="sessions-client-main">
        {activeView === 'chat' && <SessionChatWorkspace {...chatProps} />}
        {activeView === 'new' && <NewSessionWorkspace {...newSessionProps} />}
      </main>
    </div>
  );
}
