import { render, screen } from '@testing-library/react-native';

import App from './App';

describe('App', () => {
  it('shows the starter screen on launch', async () => {
    // Arrange
    const starterMessage = 'Open up App.tsx to start working on your app!';

    // Act
    await render(<App />);

    // Assert
    expect(screen.getByText(starterMessage)).toBeVisible();
  });
});
