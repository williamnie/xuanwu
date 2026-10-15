import { ArrowRight, Moon, Sun } from 'lucide-react';
import BrandMark from '../components/BrandMark.jsx';
import FirstDeliveryGuide from './command-center/FirstDeliveryGuide.jsx';
import './OnboardingPage.css';

export default function OnboardingPage({ checkSavedConnection, onComplete, onOpenWork, onSkip, projects, theme, toggleTheme }) {
  return (
    <div className="onboarding-page-shell">
      <header className="onboarding-page-topbar">
        <div>
          <BrandMark state="guarding" />
          <div className="onboarding-page-actions">
            <span>FIRST-RUN SETUP</span>
            <button aria-label={theme === 'dark' ? '切换至浅色主题' : '切换至深色主题'} onClick={toggleTheme} title="切换主题" type="button">
              {theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
            </button>
            <button className="onboarding-page-skip" onClick={onSkip} type="button">稍后设置 <ArrowRight size={13} /></button>
          </div>
        </div>
      </header>

      <main className="onboarding-page-main">
        <section className="onboarding-page-intro" aria-labelledby="onboarding-page-title">
          <div>
            <span>THE SIMPLEST WAY TO USE XUANWU</span>
            <h1 id="onboarding-page-title">把任务交给玄武，从第一次交付开始</h1>
            <p>你说“现在开始，你自己看着做”。玄武会自己推进；卡住时来问你，你回一句，它继续。</p>
            <blockquote>“帮我只读检查这个项目，告诉我验证结果和下一步建议。”</blockquote>
          </div>
          <dl>
            <div><dt>你来做</dt><dd>提任务</dd></div>
            <div><dt>玄武来做</dt><dd>自己推进</dd></div>
            <div><dt>卡住以后</dt><dd>来问你</dd></div>
          </dl>
        </section>

        <FirstDeliveryGuide checkSavedConnection={checkSavedConnection} onComplete={onComplete} onOpenWork={onOpenWork} projects={projects} />
      </main>

      <footer className="onboarding-page-footer"><span>XUANWU · APACHE-2.0</span><span>FIRST DELIVERY ONBOARDING</span></footer>
    </div>
  );
}
