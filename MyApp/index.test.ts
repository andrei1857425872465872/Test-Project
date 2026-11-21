import { registerRootComponent } from 'expo';

import App from './App';

jest.mock('expo', () => ({
  ...jest.requireActual<typeof import('expo')>('expo'),
  registerRootComponent: jest.fn(),
}));

describe('app entry point', () => {
  it('registers App as the root component once', () => {
    // Arrange
    const registerApp = jest.mocked(registerRootComponent);

    // Act
    jest.requireActual('./index');

    // Assert
    expect(registerApp).toHaveBeenCalledTimes(1);
    expect(registerApp).toHaveBeenCalledWith(App);
  });
});
