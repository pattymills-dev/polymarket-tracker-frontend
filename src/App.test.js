import { render, screen } from '@testing-library/react';
import App from './App';
import { ThemeProvider } from './ThemeContext';

test('renders loading state', () => {
  render(
    <ThemeProvider>
      <App />
    </ThemeProvider>
  );
  expect(screen.getByText(/loading activity/i)).toBeInTheDocument();
});
